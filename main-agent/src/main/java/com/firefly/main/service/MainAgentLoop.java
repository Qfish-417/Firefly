package com.firefly.main.service;

import com.firefly.main.inbox.Inbox;
import com.firefly.main.statemachine.SeckillStockStrategy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;

/**
 * 主力 Agent 内部循环（while True，事件驱动混合）
 * - 定时扫 status=parsed 需求 → 跑生成流水线
 * - 定时自评 → 调侦察
 * - 收件箱消息处理（deploy_subagent 回报灰度状态）
 *
 * 设计文档 4.4：主力的循环是事件驱动混合——业务请求优先，迭代任务次之
 * HTTP 请求由 Controller 处理，本类负责定时驱动部分
 */
@Service
public class MainAgentLoop {

    @Autowired
    private JdbcTemplate jdbc;
    @Autowired
    private com.firefly.main.tool.MainToolRegistry toolRegistry;
    @Autowired
    private ScoutClient scoutClient;
    @Autowired
    private Inbox inbox;
    @Autowired
    private SeckillStockStrategy stockStrategy;

    /** 每分钟扫待处理需求，触发生成流水线 */
    @Scheduled(fixedRate = 60000)
    public void scanPendingRequirements() {
        List<Map<String, Object>> pending = jdbc.queryForList(
                "SELECT id FROM interface_requirement WHERE status='parsed' LIMIT 5");
        for (Map<String, Object> row : pending) {
            toolRegistry.triggerPipeline((String) row.get("id"));
        }
    }

    /** 上线后每5分钟自评触发（功能 8） */
    @Scheduled(fixedDelay = 300000)
    public void selfEvaluate() {
        List<Map<String, Object>> online = jdbc.queryForList(
                "SELECT DISTINCT service FROM release WHERE status='100'");
        for (Map<String, Object> row : online) {
            Map<String, Object> result = scoutClient.evaluate(
                    (String) row.get("service"), "latest");
            // 评估结果存日志，低于基线由侦察主动产改进点
            System.out.println("[自评] " + row.get("service") + " → " + result);
        }
    }

    /** 每10秒处理收件箱（deploy_subagent 回报灰度状态推进） */
    @Scheduled(fixedRate = 10000)
    public void processInbox() {
        List<Map<String, Object>> msgs = inbox.drain("main");
        for (Map<String, Object> msg : msgs) {
            String type = (String) msg.get("type");
            if ("canary_status".equals(type)) {
                // deploy_subagent 回报灰度状态，推进 canary_pct
                System.out.println("[灰度回报] " + msg);
                // TODO: 据 healthy 字段推进 5→50→100 或触发回滚
            }
        }
    }
}
