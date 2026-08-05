package com.firefly.main.controller;

import com.firefly.main.model.InterfaceRequirement;
import com.firefly.main.tool.MainToolRegistry;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

import java.util.Map;
import java.util.UUID;

/**
 * 需求提交与生成流水线触发（功能 1-6 入口）
 * 业务方提交接口需求 → 写库 → 触发主循环跑 解析→RAG→生成→测试→注册→灰度
 */
@RestController
@RequestMapping("/api/requirement")
public class RequirementController {

    @Autowired
    private JdbcTemplate jdbc;
    @Autowired
    private MainToolRegistry toolRegistry;

    /** 提交接口需求 */
    @PostMapping
    public Map<String, Object> submit(@RequestBody Map<String, Object> body) {
        String id = "req-" + UUID.randomUUID().toString().substring(0, 12);
        jdbc.update("INSERT INTO interface_requirement(id, business_domain, requirement_text, field_table, sla, status, created_by) " +
                        "VALUES(?,?,?,?,?,?,?)",
                id,
                body.getOrDefault("businessDomain", "course"),
                body.get("requirementText"),
                body.getOrDefault("fieldTable", "{}"),
                body.getOrDefault("sla", "{}"),
                "parsed",
                body.getOrDefault("createdBy", "business"));
        // 触发生成流水线（实际由 MainAgentLoop 轮询 status=parsed 触发，这里异步唤醒）
        toolRegistry.triggerPipeline(id);
        return Map.of("code", 0, "requirementId", id, "status", "parsed");
    }

    /** 查需求状态 */
    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable String id) {
        return jdbc.queryForMap("SELECT * FROM interface_requirement WHERE id=?", id);
    }
}
