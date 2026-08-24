"""
FireFly 升级 Agent - FastAPI 主入口
角色：执行变更者，消费改进点，安全地改主力代码并上线
最危险的一环——能动主力源码。设计核心：护栏 + 分档 + 回滚
触发模型：阶段性升级清单（upgrade_plan）+ 管理员排期 + 紧急直通
"""
import os
import threading
import httpx
from fastapi import FastAPI
from pydantic import BaseModel

from src.core.upgrade_loop import UpgradeLoop
from src.core.plan_scheduler import PlanScheduler
from src.tool.upgrade_tools import UpgradeToolRegistry
from src.rag.rag_search import RagSearcher
from src.inbox.inbox import Inbox

app = FastAPI(title="FireFly Upgrade Agent", version="0.1.0")

tool_registry = UpgradeToolRegistry()
rag = RagSearcher()
inbox = Inbox()
loop = UpgradeLoop(tool_registry, rag, inbox)
scheduler = PlanScheduler(loop)


def register_to_nacos():
    nacos_addr = os.getenv("NACOS_ADDR", "localhost:8848")
    ip = os.getenv("SERVICE_IP", "127.0.0.1")
    try:
        httpx.post(
            f"http://{nacos_addr}/nacos/v1/ns/instance",
            params={"serviceName": "firefly-upgrade-agent",
                    "ip": ip, "port": 8082,
                    "metadata": {"agent": "upgrade", "lang": "python"}},
            timeout=5)
        print(f"[Nacos] 升级 Agent 注册成功 {ip}:8082")
    except Exception as e:
        print(f"[Nacos] 注册失败（可降级运行）: {e}")


class TriggerPlanRequest(BaseModel):
    """管理员手动触发清单"""
    plan_id: str
    operator: str
    reason: str = ""


@app.on_event("startup")
def startup():
    register_to_nacos()
    threading.Thread(target=loop.run, daemon=True).start()
    scheduler.start()  # 清单调度器（每分钟扫到点清单）
    print("[启动] 升级 Agent 内部循环 + 清单调度已启动")


@app.get("/health")
def health():
    return {"status": "UP", "service": "firefly-upgrade-agent", "version": "0.1.0"}


@app.post("/trigger-plan")
def trigger_plan(req: TriggerPlanRequest):
    """管理员手动触发某清单提前执行（gRPC TriggerPlan 等效）"""
    accepted = loop.trigger_plan(req.plan_id, req.operator, req.reason)
    return {"accepted": accepted, "plan_id": req.plan_id}


@app.get("/improvement/{imp_id}/status")
def improvement_status(imp_id: str):
    """查询改进点当前状态（gRPC QueryImprovementStatus 等效）"""
    return loop.query_status(imp_id)


@app.post("/notify-rollback")
def notify_rollback(req: dict):
    """主力通知升级：某 release 灰度失败需回滚"""
    loop.handle_rollback_notification(req.get("release_id", ""), req.get("reason", ""))
    return {"accepted": True}
