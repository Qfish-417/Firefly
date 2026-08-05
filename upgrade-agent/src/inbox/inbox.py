"""持久收件箱（升级 Agent 用，与 shared/inbox 对齐）
/data/inbox/{agent_name}.jsonl，append 写 / drain 读
用于 rollback_subagent 回报退化等跨轮通信
"""
import os
import json
import time
from typing import List, Dict


class Inbox:
    INBOX_DIR = os.getenv("INBOX_DIR", "/data/inbox")

    def send(self, to_agent: str, message: Dict):
        os.makedirs(self.INBOX_DIR, exist_ok=True)
        path = os.path.join(self.INBOX_DIR, f"{to_agent}.jsonl")
        message["ts"] = int(time.time())
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(message, ensure_ascii=False) + "\n")

    def drain(self, agent_name: str) -> List[Dict]:
        path = os.path.join(self.INBOX_DIR, f"{agent_name}.jsonl")
        if not os.path.exists(path):
            return []
        with open(path, "r+", encoding="utf-8") as f:
            lines = f.readlines()
            f.seek(0); f.truncate()
        return [json.loads(line) for line in lines if line.strip()]
