"""
持久收件箱（三 Agent 共用，teammate 通信，.jsonl）
/data/inbox/{agent_name}.jsonl，append 写 / drain 读
跨重启不丢，用于 deploy_subagent/rollback_subagent 回报等跨轮通信
源自乐享 s09/s15 MessageBus
"""
import os
import json
from typing import List, Dict


class Inbox:
    INBOX_DIR = os.getenv("INBOX_DIR", "/data/inbox")

    def send(self, to_agent: str, message: Dict):
        """写消息（append，跨重启不丢）"""
        os.makedirs(self.INBOX_DIR, exist_ok=True)
        path = os.path.join(self.INBOX_DIR, f"{to_agent}.jsonl")
        message["ts"] = int(__import__("time").time())
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(message, ensure_ascii=False) + "\n")

    def drain(self, agent_name: str) -> List[Dict]:
        """读取并清空所有消息"""
        path = os.path.join(self.INBOX_DIR, f"{agent_name}.jsonl")
        if not os.path.exists(path):
            return []
        with open(path, "r+", encoding="utf-8") as f:
            lines = f.readlines()
            f.seek(0); f.truncate()  # 清空
        msgs = []
        for line in lines:
            line = line.strip()
            if line:
                msgs.append(json.loads(line))
        return msgs
