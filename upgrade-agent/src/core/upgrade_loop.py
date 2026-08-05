"""
升级 Agent 内部循环（while True，清单驱动 + 紧急直通 + 收件箱）
设计文档 6.7：
- MQ 改进点 → 只入 improvement 表 status=pending（待规划池），不触发升级
- 清单到点/紧急直通/管理员手动 → 才真正执行
- 收件箱：rollback_subagent 回报退化 → 触发回滚

关键：MQ 只是入队通道不触发升级，触发权在管理员排期/紧急直通手里
"""
import time
import threading
import psycopg2
import os
import json
from typing import List

from src.core.dag_engine import build_dag_from_improvements


class UpgradeLoop:
    def __init__(self, tool_registry, rag, inbox):
        self.tools = tool_registry
        self.rag = rag
        self.inbox = inbox
        self._exec_lock = threading.Lock()  # 防并发执行多批

    def run(self):
        """主循环（后台线程）：处理 MQ 入队 + 收件箱回滚回报"""
        print("[升级循环] 启动")
        while True:
            try:
                # 1. 消费 MQ 改进点 → 只入 pending（不触发）
                # TODO: rocketmq consumer 消费 improvement_topic
                # self._consume_improvement_mq()

                # 2. 处理收件箱（rollback_subagent 回报退化）
                msgs = self.inbox.drain("upgrade")
                for msg in msgs:
                    if msg.get("type") == "rollback_degradation":
                        self.handle_rollback_notification(
                            msg.get("release_id", ""), msg.get("reason", "灰度退化"))

                # 3. 清理超期 worktree + 连续3次失败标 needs_human
                self._cleanup()
            except Exception as e:
                print(f"[升级循环] 异常: {e}")
            time.sleep(10)

    def execute_plan(self, plan_id: str, improvement_ids: List[str], is_emergency: bool):
        """执行升级清单（由 plan_scheduler 或管理员手动触发）

        图引擎编排（6.5.2）：用 DAG 调度替代串行循环。
        - 同文件改进点 → DAG 串行边
        - 异文件改进点 → 并行执行
        - 每节点内部仍跑完整 L1/L2/L3 loop（_process_one_improvement）
        """
        with self._exec_lock:
            print(f"[执行清单] {plan_id} improvements={improvement_ids} emergency={is_emergency}")
            # 发业务公告：开始
            self.tools.call("announce", {
                "plan_id": plan_id, "level": "critical" if is_emergency else "info",
                "title": f"升级清单 {plan_id} 开始执行", "status": "active"})

            # 拉取改进点详情（含 target_files / level）
            improvements = []
            for imp_id in improvement_ids:
                imp = self._get_improvement(imp_id)
                if imp:
                    improvements.append(imp)
                else:
                    print(f"[执行清单] 改进点 {imp_id} 不存在，跳过")

            if not improvements:
                self._update_plan_status(plan_id, "done")
                return

            # 紧急直通：观察窗口加倍（6.0.1 护栏）
            observe_multiplier = 2 if is_emergency else 1

            # 图引擎建图 + 调度
            def make_task(imp):
                """每个 DAG 节点的 task：内部跑完整 loop（L1/L2/L3 分档）"""
                def task():
                    return self._process_one_improvement(imp["id"], is_emergency)
                return task

            # 并发度从 Nacos 读（TODO: 接 Nacos 配置），默认 3
            max_workers = int(os.getenv("UPGRADE_CONCURRENCY", "3"))

            dag = build_dag_from_improvements(
                improvements, task_factory=make_task, max_workers=max_workers)
            print(f"[执行清单] DAG 建图完成，节点数={len(improvements)} 并发度={max_workers}")

            results = dag.execute(max_workers=max_workers)

            # 结果汇总：任一节点 failed → 整体回滚标记（6.5.3 局部/整体回滚由 _process_one_improvement 内部处理）
            failed_ids = [nid for nid, r in results.items() if r["status"] == "failed"]
            skipped_ids = [nid for nid, r in results.items() if r["status"] == "skipped"]
            overall_rolled_back = len(failed_ids) > 0

            if failed_ids:
                print(f"[执行清单] 失败节点: {failed_ids}（已局部回滚，改进点回 pending）")
            if skipped_ids:
                print(f"[执行清单] 跳过节点(依赖失败): {skipped_ids}")

            # 更新清单状态
            status = "rolled_back" if overall_rolled_back else "done"
            self._update_plan_status(plan_id, status)
            # 发业务公告：完成/回滚
            self.tools.call("announce", {
                "plan_id": plan_id, "level": "warning" if overall_rolled_back else "info",
                "title": f"升级清单 {plan_id} {'已回滚' if overall_rolled_back else '执行完成'}"
                         f"（成功{sum(1 for r in results.values() if r['status']=='success')}"
                         f"/失败{len(failed_ids)}/跳过{len(skipped_ids)}）",
                "status": "resolved" if not overall_rolled_back else "active"})

    def _process_one_improvement(self, imp_id: str, is_emergency: bool) -> bool:
        """处理单个改进点：读 level → 分档执行 L1/L2/L3"""
        imp = self._get_improvement(imp_id)
        if not imp:
            return False
        level = imp.get("level", "L1")
        print(f"[改进点] {imp_id} level={level} → 分档执行")

        try:
            if level == "L1":
                return self.tools.call("l1_soft_upgrade", {"improvement": imp}).get("ok", False)
            elif level == "L2":
                return self.tools.call("l2_strategy_upgrade", {"improvement": imp}).get("ok", False)
            elif level == "L3":
                # L3 走完整流水线（分阶段处理，不是有红就滚）
                from src.pipeline.upgrade_pipeline import L3Pipeline
                result = L3Pipeline(self.tools).run(imp, is_emergency)
                return result.get("success", False)
        except Exception as e:
            print(f"[改进点] {imp_id} 执行失败: {e}")
            # 失败回 pending，下次再试；连续3次失败标 needs_human
            self._mark_retry_or_human(imp_id)
            return False
        return False

    def trigger_plan(self, plan_id: str, operator: str, reason: str) -> bool:
        """管理员手动触发清单提前执行"""
        conn = self._pg(); cur = conn.cursor()
        cur.execute("SELECT improvement_ids FROM upgrade_plan WHERE plan_id=%s AND status='scheduled'",
                    (plan_id,))
        row = cur.fetchone()
        if not row:
            cur.close(); conn.close()
            return False
        cur.execute("UPDATE upgrade_plan SET status='running' WHERE plan_id=%s", (plan_id,))
        conn.commit(); cur.close(); conn.close()
        threading.Thread(target=self.execute_plan,
                         args=(plan_id, row[0] if isinstance(row[0], list) else json.loads(row[0]), False),
                         daemon=True).start()
        return True

    def handle_rollback_notification(self, release_id: str, reason: str):
        """处理回滚通知（灰度退化）"""
        print(f"[回滚通知] release={release_id} reason={reason}")
        self.tools.call("rollback_executor", {
            "release_id": release_id, "reason": reason, "scope": "partial"})

    def query_status(self, imp_id: str) -> dict:
        imp = self._get_improvement(imp_id)
        return {"status": imp.get("status") if imp else "not_found",
                "plan_id": imp.get("plan_id") if imp else None,
                "detail": imp.get("problem_desc", "") if imp else ""}

    def _dependency_analysis(self, improvement_ids: List[str]) -> List[List[str]]:
        """[已弃用] 依赖分析：已被 DAG 编排引擎替代（6.5.2）。
        保留作为 fallback/单任务串行路径。DAG 建图逻辑见 dag_engine.build_dag_from_improvements。"""
        return [[imp_id] for imp_id in improvement_ids]

    def _get_improvement(self, imp_id: str) -> dict:
        conn = self._pg(); cur = conn.cursor()
        cur.execute("SELECT * FROM improvement WHERE id=%s", (imp_id,))
        cols = [d[0] for d in cur.description]
        row = cur.fetchone()
        cur.close(); conn.close()
        return dict(zip(cols, row)) if row else None

    def _mark_retry_or_human(self, imp_id: str):
        conn = self._pg(); cur = conn.cursor()
        cur.execute("UPDATE improvement SET fail_count=fail_count+1 WHERE id=%s", (imp_id,))
        cur.execute("SELECT fail_count FROM improvement WHERE id=%s", (imp_id,))
        cnt = cur.fetchone()
        if cnt and cnt[0] >= 3:
            cur.execute("UPDATE improvement SET status='needs_human' WHERE id=%s", (imp_id,))
            print(f"[改进点] {imp_id} 连续3次失败，标 needs_human")
        else:
            cur.execute("UPDATE improvement SET status='pending' WHERE id=%s", (imp_id,))
        conn.commit(); cur.close(); conn.close()

    def _update_plan_status(self, plan_id: str, status: str):
        conn = self._pg(); cur = conn.cursor()
        cur.execute("UPDATE upgrade_plan SET status=%s WHERE plan_id=%s", (status, plan_id))
        conn.commit(); cur.close(); conn.close()

    def _cleanup(self):
        """清理超期 worktree + needs_human 告警"""
        # TODO: git worktree prune，清理 >24h 未合并的 worktree
        pass

    @staticmethod
    def _pg():
        return psycopg2.connect(
            host=os.getenv("POSTGRES_HOST", "localhost"),
            dbname="firefly", user="firefly", password="firefly123")
