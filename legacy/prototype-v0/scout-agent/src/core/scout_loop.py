"""
侦察 Agent 内部循环（while True，纯任务驱动）
设计文档 5.4：
- 任务看板有评估任务 → CLAIM → 并行跑指标+日志+测试 → 打分 → 产改进点 → 推MQ
- 收到主力 evaluate_call → 同步握手（由 app.py /evaluate 处理）
- 纯任务驱动，无业务流量，无状态机，无对外 API（除同步握手）
"""
import time
import threading
import psycopg2
from typing import Optional


class ScoutLoop:
    def __init__(self, tool_registry, scorer, rag, inbox):
        self.tools = tool_registry
        self.scorer = scorer
        self.rag = rag
        self.inbox = inbox

    def run(self):
        """主循环（后台线程）"""
        print("[侦察循环] 启动")
        while True:
            try:
                task = self._claim_task()
                if task:
                    self._process_task(task)
                else:
                    time.sleep(30)  # 无任务轮询间隔
            except Exception as e:
                print(f"[侦察循环] 异常: {e}")
                time.sleep(10)

    def run_full_assess(self, task_id: str, service: str, version: str):
        """完整评估（异步，由 /full-assess 触发）"""
        print(f"[完整评估] task={task_id} service={service}")
        self._do_assess(service, version)

    def _claim_task(self) -> Optional[dict]:
        """CLAIM 任务看板（CAS 防竞争）"""
        try:
            conn = self._pg()
            cur = conn.cursor()
            # CAS：claim 一个 open 任务
            cur.execute(
                "UPDATE task_board SET status='claimed', owner='scout', claimed_at=NOW() "
                "WHERE id IN (SELECT id FROM task_board WHERE status='open' AND type='evaluate' LIMIT 1) "
                "RETURNING id, payload")
            row = cur.fetchone()
            conn.commit()
            cur.close(); conn.close()
            if row:
                import json
                return {"id": row[0], "payload": row[1] if isinstance(row[1], dict) else json.loads(row[1])}
        except Exception as e:
            print(f"[CLAIM] 失败: {e}")
        return None

    def _process_task(self, task: dict):
        """处理评估任务：并行跑指标+日志+测试 → 打分 → 产改进点 → 推MQ"""
        payload = task.get("payload", {})
        service = payload.get("service", "firefly-main-agent")
        version = payload.get("version", "latest")

        self._do_assess(service, version)

        # 标记任务完成
        try:
            conn = self._pg()
            cur = conn.cursor()
            cur.execute("UPDATE task_board SET status='done' WHERE id=%s", (task["id"],))
            conn.commit(); cur.close(); conn.close()
        except Exception:
            pass

    def _do_assess(self, service: str, version: str):
        """完整评估流程：指标→日志→测试→打分→改进点→经验→MQ

        图引擎编排（6.5.2）：采集阶段三任务互不依赖，DAG 并行执行。
        """
        from src.core.dag_engine import DAG

        # 1. 并行采集（DAG：三任务无依赖，并行）
        dag = DAG(name=f"scout_collect_{service}")
        dag.add_node("metrics", lambda: self.tools.call("metric_scraper", {"service": service}))
        dag.add_node("logs", lambda: self.tools.call("log_collector", {"service": service}))
        dag.add_node("tests", lambda: self.tools.call("test_runner", {"service": service}))
        dag.seal()
        results = dag.execute(max_workers=3)

        metrics = (results.get("metrics", {}).get("result")) or {}
        logs = (results.get("logs", {}).get("result")) or {}
        test_report = (results.get("tests", {}).get("result")) or {}

        # 2. 打分
        score_report = self.scorer.score(metrics)
        print(f"[评估] {service} score={score_report['overall']} trend={score_report['trend']}")

        # 3. 分数低于基线 → 产改进点
        if score_report["overall"] < 0.95:
            rag_ctx = self.tools.call("rag_search", {
                "query": f"{service} 缺陷 超卖 性能", "domain": "seckill"})
            result = self.tools.call("improvement_finder", {
                "score": score_report["overall"],
                "metrics": metrics, "logs": logs, "rag_context": rag_ctx})
            improvements = result.get("improvements", [])

            # 4. 写经验库 + 5. 推 MQ 通知升级
            for imp in improvements:
                self.tools.call("experience_writer", {
                    "type": "defect_case", "content": imp["problem_desc"],
                    "domain": "seckill", "outcome": "failure", "tags": [imp["level"]]})
                self.tools.call("mq_publish", {"improvement": imp})
                print(f"[改进点] {imp['id']} {imp['priority']}/{imp['level']} → MQ")

    @staticmethod
    def _pg():
        import os
        return psycopg2.connect(
            host=os.getenv("POSTGRES_HOST", "localhost"),
            dbname="firefly", user="firefly", password="firefly123")
