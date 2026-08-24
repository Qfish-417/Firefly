"""
升级清单调度器（设计文档 6.0.1）
每分钟跑一次 plan_scheduler：
1. 紧急直通：mode=emergency 的清单立即执行（重大生产事故，不经管理员确认）
2. 清单到点：status=scheduled and scheduled_at<=now 的清单执行
3. 管理员手动触发的清单由 gRPC /trigger-plan 直接置 running + 入批

组批权在管理员手里，不在自动阈值手里。管理员不排期的改进点永远不执行。
"""
import time
import threading
import psycopg2
import os


class PlanScheduler:
    def __init__(self, loop):
        self.loop = loop

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()
        print("[清单调度] 启动（每分钟扫一次）")

    def _run(self):
        while True:
            try:
                self._scan()
            except Exception as e:
                print(f"[清单调度] 异常: {e}")
            time.sleep(60)

    def _scan(self):
        conn = self._pg()
        cur = conn.cursor()

        # 1. 紧急直通（最高优先级，不等排期）——重大生产事故直接给 agent
        cur.execute(
            "SELECT plan_id, improvement_ids FROM upgrade_plan "
            "WHERE mode='emergency' AND status IN ('draft','scheduled')")
        for plan_id, imp_ids in cur.fetchall():
            print(f"[紧急直通] 清单 {plan_id} 立即执行（重大生产事故）")
            cur.execute("UPDATE upgrade_plan SET status='running' WHERE plan_id=%s", (plan_id,))
            conn.commit()
            self.loop.execute_plan(plan_id, imp_ids, is_emergency=True)

        # 2. 清单到点（管理员排期到点）
        cur.execute(
            "SELECT plan_id, improvement_ids FROM upgrade_plan "
            "WHERE status='scheduled' AND scheduled_at <= NOW()")
        for plan_id, imp_ids in cur.fetchall():
            print(f"[清单到点] 清单 {plan_id} 开始执行")
            cur.execute("UPDATE upgrade_plan SET status='running' WHERE plan_id=%s", (plan_id,))
            conn.commit()
            self.loop.execute_plan(plan_id, imp_ids, is_emergency=False)

        cur.close(); conn.close()

    @staticmethod
    def _pg():
        return psycopg2.connect(
            host=os.getenv("POSTGRES_HOST", "localhost"),
            dbname="firefly", user="firefly", password="firefly123")
