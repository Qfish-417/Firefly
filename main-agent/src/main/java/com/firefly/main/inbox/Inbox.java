package com.firefly.main.inbox;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.io.File;
import java.io.FileWriter;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 持久收件箱（teammate 通信，.jsonl）
 * /data/inbox/{agent_name}.jsonl，append 写 / drain 读
 * 用于 deploy_subagent 回报灰度状态、rollback_subagent 回报退化等跨轮通信
 * 源自乐享 s09/s15 MessageBus 机制
 */
@Component
public class Inbox {

    private final ObjectMapper mapper = new ObjectMapper();
    private static final String INBOX_DIR = System.getenv().getOrDefault("INBOX_DIR", "/data/inbox");

    /** 写消息（append 模式，跨重启不丢） */
    public void send(String toAgent, Map<String, Object> message) {
        try {
            File dir = new File(INBOX_DIR);
            if (!dir.exists()) dir.mkdirs();
            File f = new File(dir, toAgent + ".jsonl");
            message.put("ts", System.currentTimeMillis() / 1000);
            try (FileWriter fw = new FileWriter(f, true)) {
                fw.write(mapper.writeValueAsString(message) + "\n");
            }
        } catch (Exception e) {
            throw new RuntimeException("收件箱写入失败", e);
        }
    }

    /** 读取并清空所有消息（drain） */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> drain(String agentName) {
        List<Map<String, Object>> msgs = new ArrayList<>();
        File f = new File(INBOX_DIR, agentName + ".jsonl");
        if (!f.exists()) return msgs;
        try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
            String line;
            while ((line = raf.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                msgs.add(mapper.readValue(line.getBytes(StandardCharsets.UTF_8), Map.class));
            }
            // 清空文件
            raf.setLength(0);
        } catch (Exception e) {
            throw new RuntimeException("收件箱读取失败", e);
        }
        return msgs;
    }
}
