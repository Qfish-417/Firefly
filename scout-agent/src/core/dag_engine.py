"""
轻量 DAG 编排引擎（图引擎调度层）
设计文档 6.5.2：图引擎不替代 loop，是 loop 的并行调度层。

职责：
- 任务建依赖图（DAG）
- 拓扑排序 + concurrent.futures 并发执行无依赖节点
- 故障隔离：单节点失败不影响无依赖的其他节点继续跑
- 循环依赖检测（防死锁）
- 结果收集：每节点的成功/失败/异常

不引入 Airflow/Temporal 等重引擎，单机 Compose 阶段够用。
每个节点内部的 task 是一个 callable，通常跑完整 loop（如 L3 流水线）。
"""
from __future__ import annotations
import threading
import time
from concurrent.futures import ThreadPoolExecutor, Future, wait, FIRST_COMPLETED
from typing import Callable, Dict, List, Any, Optional, Set


class DAGNode:
    """DAG 节点：一个 task + 它的依赖列表。task 内部跑完整 loop。"""

    def __init__(self, node_id: str, task: Callable[[], Any],
                 depends_on: Optional[List[str]] = None,
                 level: str = "L1",
                 target_files: Optional[List[str]] = None,
                 meta: Optional[dict] = None):
        self.id = node_id
        self.task = task                       # callable，内部跑 loop
        self.depends_on = list(depends_on or [])
        self.level = level                      # L1/L2/L3，用于日志
        self.target_files = list(target_files or [])
        self.meta = meta or {}

        # 运行时状态
        self.status: str = "pending"            # pending/running/success/failed/skipped
        self.result: Any = None
        self.error: Optional[Exception] = None
        self.start_ts: Optional[float] = None
        self.end_ts: Optional[float] = None

    def duration(self) -> float:
        if self.start_ts and self.end_ts:
            return self.end_ts - self.start_ts
        return 0.0

    def __repr__(self):
        return f"<DAGNode {self.id} level={self.level} status={self.status} deps={self.depends_on}>"


class DAG:
    """有向无环图。线程安全：建图阶段加锁，执行阶段只读。"""

    def __init__(self, name: str = "dag"):
        self.name = name
        self._nodes: Dict[str, DAGNode] = {}
        self._lock = threading.Lock()
        self._sealed = False  # 建图完成后置 True，执行时只读

    def add_node(self, node_id: str, task: Callable[[], Any],
                 depends_on: Optional[List[str]] = None,
                 level: str = "L1",
                 target_files: Optional[List[str]] = None,
                 meta: Optional[dict] = None) -> DAGNode:
        """添加节点。depends_on 里的 id 必须已存在（前向声明）。"""
        with self._lock:
            if self._sealed:
                raise RuntimeError(f"DAG[{self.name}] 已 sealed，不能再加节点")
            if node_id in self._nodes:
                raise ValueError(f"节点 id 重复: {node_id}")
            # 校验依赖存在
            for dep in (depends_on or []):
                if dep not in self._nodes:
                    raise ValueError(f"依赖的节点不存在: {dep}（需先添加）")
            node = DAGNode(node_id, task, depends_on, level, target_files, meta)
            self._nodes[node_id] = node
            return node

    def seal(self):
        """建图完成，锁定。执行前必须 seal。"""
        self._detect_cycle()
        with self._lock:
            self._sealed = True

    def _detect_cycle(self):
        """拓扑排序检测循环依赖（死锁防护）。"""
        in_degree: Dict[str, int] = {nid: 0 for nid in self._nodes}
        adj: Dict[str, List[str]] = {nid: [] for nid in self._nodes}
        for node in self._nodes.values():
            for dep in node.depends_on:
                adj[dep].append(node.id)
                in_degree[node.id] += 1

        queue = [nid for nid, d in in_degree.items() if d == 0]
        visited = 0
        tmp_indeg = dict(in_degree)
        while queue:
            cur = queue.pop(0)
            visited += 1
            for nxt in adj[cur]:
                tmp_indeg[nxt] -= 1
                if tmp_indeg[nxt] == 0:
                    queue.append(nxt)
        if visited != len(self._nodes):
            remaining = [nid for nid, d in tmp_indeg.items() if d > 0]
            raise ValueError(f"DAG[{self.name}] 检测到循环依赖，涉及节点: {remaining}")

    def execute(self, max_workers: int = 3,
                on_node_start: Optional[Callable[[DAGNode], None]] = None,
                on_node_done: Optional[Callable[[DAGNode], None]] = None) -> Dict[str, dict]:
        """
        执行 DAG：拓扑序 + 线程池并发。
        - 无依赖节点立即并行
        - 有依赖节点等依赖全部 success 后才 ready
        - 依赖节点 failed 的节点 → 标 skipped（不执行，故障隔离）
        - 返回 {node_id: {status, result, error, duration}}
        """
        if not self._sealed:
            self.seal()

        print(f"[DAG:{self.name}] 开始执行，节点数={len(self._nodes)} max_workers={max_workers}")

        with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix=f"dag-{self.name}") as pool:
            futures: Dict[Future, DAGNode] = {}
            done_ids: Set[str] = set()

            def submit_ready():
                """提交所有依赖已满足且未执行的节点。"""
                for node in self._nodes.values():
                    if node.status != "pending":
                        continue
                    # 依赖里有 failed/skipped → 本节点跳过（故障隔离）
                    dep_statuses = [self._nodes[d].status for d in node.depends_on]
                    if any(s in ("failed", "skipped") for s in dep_statuses):
                        node.status = "skipped"
                        node.end_ts = time.time()
                        print(f"[DAG:{self.name}] 节点 {node.id} 跳过（依赖失败）")
                        done_ids.add(node.id)
                        if on_node_done:
                            on_node_done(node)
                        continue
                    # 依赖全部 success → 可提交
                    if all(self._nodes[d].status == "success" for d in node.depends_on):
                        node.status = "running"
                        node.start_ts = time.time()
                        if on_node_start:
                            on_node_start(node)
                        fut = pool.submit(self._run_node, node)
                        futures[fut] = node

            submit_ready()
            while futures:
                done, _ = wait(list(futures.keys()), return_when=FIRST_COMPLETED)
                for fut in done:
                    node = futures.pop(fut)
                    try:
                        fut.result()  # 异常已在 _run_node 内捕获并写入 node
                    except Exception as e:
                        node.error = e
                        node.status = "failed"
                    node.end_ts = time.time()
                    done_ids.add(node.id)
                    if on_node_done:
                        on_node_done(node)
                # 提交新一轮 ready 节点
                submit_ready()

        # 收集结果
        results: Dict[str, dict] = {}
        for nid, node in self._nodes.items():
            results[nid] = {
                "status": node.status,
                "result": node.result,
                "error": str(node.error) if node.error else None,
                "duration": round(node.duration(), 2),
                "level": node.level,
            }
        succ = sum(1 for r in results.values() if r["status"] == "success")
        fail = sum(1 for r in results.values() if r["status"] == "failed")
        skip = sum(1 for r in results.values() if r["status"] == "skipped")
        print(f"[DAG:{self.name}] 执行完成 success={succ} failed={fail} skipped={skip}")
        return results

    @staticmethod
    def _run_node(node: DAGNode):
        """节点任务执行包装：捕获异常，写入 node.status/result/error。"""
        try:
            print(f"[DAG] 节点 {node.id} 开始 (level={node.level} files={node.target_files})")
            res = node.task()
            node.result = res
            node.status = "success"
            print(f"[DAG] 节点 {node.id} 成功 ({node.duration():.1f}s)")
        except Exception as e:
            node.error = e
            node.status = "failed"
            print(f"[DAG] 节点 {node.id} 失败: {e}")


def build_dag_from_improvements(improvements: List[dict],
                                task_factory: Callable[[dict], Callable[[], Any]],
                                max_workers: int = 3) -> DAG:
    """
    便捷构造：根据改进点列表 + target_files 自动建 DAG。
    - 同 target_file 的改进点 → 串行（后者在 depends_on 里写前者）
    - 不同 target_file → 并行（无依赖边）
    - 返回 seal 好的 DAG，可直接 execute()

    improvements: [{"id":"imp_001","level":"L3","target_files":["SeckillServiceImpl.java"]}, ...]
    task_factory: 把 improvement 转成 callable（内部跑 L1/L2/L3 loop）
    """
    dag = DAG(name="upgrade_batch")
    # 按文件分组，记录每个文件最后加入的节点 id（用于串行依赖）
    file_last_node: Dict[str, str] = {}

    # 先按 target_files 排序，保证同文件节点按顺序串行
    sorted_imps = sorted(improvements, key=lambda x: (x.get("target_files", [""])[0] if x.get("target_files") else "", x["id"]))

    for imp in sorted_imps:
        imp_id = imp["id"]
        level = imp.get("level", "L1")
        files = imp.get("target_files", [])
        deps: List[str] = []
        # 同文件的改进点 → 依赖该文件上一个节点（串行）
        for f in files:
            if f in file_last_node:
                if file_last_node[f] not in deps:
                    deps.append(file_last_node[f])
        node = dag.add_node(imp_id, task_factory(imp), depends_on=deps,
                            level=level, target_files=files, meta={"improvement": imp})
        # 更新该文件最后节点
        for f in files:
            file_last_node[f] = imp_id

    dag.seal()
    return dag
