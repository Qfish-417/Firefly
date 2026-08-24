"""
FireFly 侦察 Agent - FastAPI 主入口
角色：观测分析者，盯主力产出的线上质量，跑测试评估，产出结构化改进点
对业务代码只读不写，不对外服务（除 /evaluate 同步握手）
循环驱动：任务看板 + 主力 evaluate_call 同步握手
"""
import os
import threading
import time
import httpx
from fastapi import FastAPI
from pydantic import BaseModel

from src.core.scout_loop import ScoutLoop
from src.tool.scout_tools import ScoutToolRegistry
from src.core.quality_scorer import QualityScorer
from src.rag.rag_search import RagSearcher
from src.inbox.inbox import Inbox

app = FastAPI(title="FireFly Scout Agent", version="0.1.0")

# 全局组件
tool_registry = ScoutToolRegistry()
scorer = QualityScorer()
rag = RagSearcher()
inbox = Inbox()
loop = ScoutLoop(tool_registry, scorer, rag, inbox)


# ---------- Nacos 注册 ----------
def register_to_nacos():
    """启动时注册到 Nacos（侦察服务 firefly-scout-agent）"""
    nacos_addr = os.getenv("NACOS_ADDR", "localhost:8848")
    ip = os.getenv("SERVICE_IP", "127.0.0.1")
    try:
        httpx.post(
            f"http://{nacos_addr}/nacos/v1/ns/instance",
            params={
                "serviceName": "firefly-scout-agent",
                "ip": ip, "port": 8081,
                "metadata": {"agent": "scout", "lang": "python"},
            }, timeout=5)
        print(f"[Nacos] 侦察 Agent 注册成功 {ip}:8081")
    except Exception as e:
        print(f"[Nacos] 注册失败（可降级运行）: {e}")


class EvaluateRequest(BaseModel):
    """主力同步握手请求"""
    service: str
    version: str
    metrics_window_sec: int = 300


@app.on_event("startup")
def startup():
    register_to_nacos()
    # 启动内部循环（后台线程）
    threading.Thread(target=loop.run, daemon=True).start()
    print("[启动] 侦察 Agent 内部循环已启动")


@app.get("/health")
def health():
    return {"status": "UP", "service": "firefly-scout-agent", "version": "0.1.0"}


@app.post("/evaluate")
def evaluate(req: EvaluateRequest):
    """同步评估接口（主力 evaluate_call 调用，设计文档 gRPC EvaluateService）"""
    # 同步握手：跑指标采集 + 打分，返回结果
    metrics = tool_registry.call("metric_scraper", {
        "service": req.service, "window_sec": req.metrics_window_sec})
    score_report = scorer.score(metrics)
    return {
        "score": score_report["overall"],
        "dimension_scores": score_report["dimensions"],
        "trend": score_report["trend"],
    }


@app.post("/full-assess")
def full_assess(req: EvaluateRequest):
    """完整评估（拉日志+跑测试+打分+产改进点+推MQ）"""
    task_id = f"task-{int(time.time())}"
    # 异步执行完整评估流程
    threading.Thread(
        target=loop.run_full_assess,
        args=(task_id, req.service, req.version), daemon=True).start()
    return {"accepted": True, "task_id": task_id}
