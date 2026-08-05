"""
侦察 Agent 工具注册中心（7 个工具，MCP 化）
设计原则（乐享 s02/s19）：工具 = handler + JSON schema，注册 dispatch map

工具清单：
1. metric_scraper      拉 Prometheus 指标（成功率/p99/QPS）
2. log_collector       拉日志分析错误模式
3. test_runner         跑回归测试
4. quality_scorer      多维打分（在 quality_scorer.py，此处转发）
5. improvement_finder  LLM 产结构化改进点
6. experience_writer   写经验库
7. mq_publish          推 MQ 通知升级
"""
import time
import uuid
import httpx
import psycopg2
from typing import Callable, Dict, Any


class ScoutToolRegistry:
    def __init__(self):
        self.dispatch: Dict[str, Callable] = {}
        self._register_all()

    def _register_all(self):
        self.dispatch["metric_scraper"] = self.metric_scraper
        self.dispatch["log_collector"] = self.log_collector
        self.dispatch["test_runner"] = self.test_runner
        self.dispatch["improvement_finder"] = self.improvement_finder
        self.dispatch["experience_writer"] = self.experience_writer
        self.dispatch["mq_publish"] = self.mq_publish
        self.dispatch["rag_search"] = self.rag_search

    def call(self, tool_name: str, input_data: Dict) -> Dict:
        handler = self.dispatch.get(tool_name)
        if not handler:
            raise ValueError(f"未知工具: {tool_name}")
        return handler(input_data)

    # ============ 7 个工具 handler ============

    def metric_scraper(self, input_data: Dict) -> Dict:
        """工具1：拉 Prometheus 指标，算 p99/avg/error_rate"""
        # TODO: 调 Prometheus API 查 {service, metric_name, time_window}
        # TODO: Prometheus 不可用→从日志反推指标（降级），写 degradation_log
        service = input_data.get("service", "firefly-main-agent")
        return {
            "interface_success_rate": 0.995,
            "seckill_p99_ms": 180,
            "order_p99_ms": 420,
            "oversell_rate": 0.003,   # >0 触发超卖改进点
            "payment_idempotent_rate": 1.0,
            "test_coverage": 0.85,
            "test_pass_rate": 1.0,
            "qps": 850,
        }

    def log_collector(self, input_data: Dict) -> Dict:
        """工具2：拉日志分析错误模式（派发 log_analyzer_subagent task）"""
        # TODO: 从 ELK/本地日志拉指定时间窗+level日志
        # TODO: 派发 log_analyzer_subagent，正则+LLM 提错误模式
        # TODO: ELK 不可用→读本地日志文件降级
        return {
            "error_patterns": [
                {
                    "pattern": "UPDATE stock WHERE stock>0 race condition",
                    "count": 42,
                    "sample_log": "ConcurrentModificationException at SeckillServiceImpl:87",
                    "root_cause_guess": "库存DB直扣高并发竞争导致超卖",
                }
            ]
        }

    def test_runner(self, input_data: Dict) -> Dict:
        """工具3：跑回归测试（派发 pytest/JUnit）"""
        # TODO: 跑全量单测+集成测试，收 JUnit XML 报告
        # TODO: 超时10min杀进程标 failed
        return {"passed": 120, "failed": 3, "coverage": 0.85, "failed_cases": []}

    def improvement_finder(self, input_data: Dict) -> Dict:
        """工具5：LLM 产结构化改进点（侦察核心产出）"""
        # TODO: 输入 {score, metrics, logs, rag_context}
        # TODO: RAG 检索历史相似缺陷修复案例（few-shot）
        # TODO: LLM 结构化产出 {target, problem, evidence, suggestion, priority, level}
        # TODO: LLM 失败重试2次→降级用规则引擎（硬编码 if-then）
        score = input_data.get("score", 0.92)
        metrics = input_data.get("metrics", {})
        # 简化：超卖率>0 产 L3 改进点
        improvements = []
        if metrics.get("oversell_rate", 0) > 0:
            improvements.append({
                "id": f"imp-{uuid.uuid4().hex[:12]}",
                "target_service": "seckill-service",
                "target_file": "SeckillServiceImpl.java",
                "problem_desc": "秒杀库存扣减存在超卖风险",
                "evidence": {
                    "metric": f"oversell_rate = {metrics.get('oversell_rate')}",
                    "log_snippet": "UPDATE stock WHERE stock>0 race condition",
                    "score_drop": 0.15,
                },
                "suggestion": "改 Redis 预扣 + MQ 异步落库（升 L2）",
                "priority": "P0",
                "level": "L3",
                "status": "pending",
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "consumed_by": None,
            })
        return {"improvements": improvements}

    def experience_writer(self, input_data: Dict) -> Dict:
        """工具6：写经验库（Milvus 向量库 + Postgres 案例表）"""
        # TODO: 写 Milvus 向量 + Postgres experience 表
        # TODO: 失败案例反哺基线（下次评估对照）
        # TODO: 向量库失败→先写 Postgres，异步补向量
        try:
            conn = psycopg2.connect(
                host=__class__._env("POSTGRES_HOST", "localhost"),
                dbname="firefly", user="firefly", password="firefly123")
            cur = conn.cursor()
            exp_id = f"exp-{uuid.uuid4().hex[:12]}"
            cur.execute(
                "INSERT INTO experience(id,type,content,domain,tags,outcome) VALUES(%s,%s,%s,%s,%s,%s)",
                (exp_id, input_data.get("type", "defect_case"),
                 input_data.get("content", ""), input_data.get("domain", "seckill"),
                 str(input_data.get("tags", [])), input_data.get("outcome", "failure")))
            conn.commit()
            cur.close(); conn.close()
            return {"ok": True, "id": exp_id}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def mq_publish(self, input_data: Dict) -> Dict:
        """工具7：推 MQ 通知升级（topic=improvement_topic）"""
        # TODO: rocketmq 发送 improvement_topic
        # TODO: 发送失败→本地重试队列+指数退避，超3次进死信人工处理
        improvement = input_data.get("improvement", {})
        print(f"[MQ] 推送改进点到 improvement_topic: {improvement.get('id')}")
        return {"msg_id": f"msg-{uuid.uuid4().hex[:8]}", "sent": True}

    def rag_search(self, input_data: Dict) -> Dict:
        """工具：RAG 检索历史错误模式+修复案例"""
        # 复用 RagSearcher（rag/rag_search.py）
        from src.rag.rag_search import RagSearcher
        return RagSearcher().search(
            query=input_data.get("query", ""),
            agent_name="scout",
            types=input_data.get("types", ["defect_case", "fix_case"]),
            domain=input_data.get("domain", ""),
        )

    @staticmethod
    def _env(key, default):
        import os
        return os.getenv(key, default)
