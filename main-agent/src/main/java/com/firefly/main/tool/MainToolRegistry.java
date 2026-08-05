package com.firefly.main.tool;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * 主力 Agent 工具注册中心（8 个工具，MCP 化）
 * 设计原则（源自乐享 s02/s19）：工具 = handler + JSON schema，注册到 dispatch map
 * 慢操作（代码生成/测试）走异步子任务，不阻塞主循环（s13）
 *
 * 工具清单：
 * 1. requirement_parser   解析需求成 OpenAPI 3.0
 * 2. rag_search           检索相似实现/规范/缺陷（混合检索）
 * 3. code_generator       生成 Spring Boot 全套代码
 * 4. test_generator       生成测试，卡覆盖率≥80%
 * 5. nacos_register       注册新接口服务到 Nacos
 * 6. sentinel_rule_push   推送 Sentinel 限流规则
 * 7. deploy_orchestrator  灰度部署 5%→50%→100%
 * 8. evaluate_call        同步调侦察评估
 */
@Component
public class MainToolRegistry {

    @Autowired
    private JdbcTemplate jdbc;

    /** 工具 dispatch map：工具名 → handler */
    private final Map<String, ToolHandler> dispatch = new HashMap<>();

    public MainToolRegistry() {
        // 注册 8 个工具
        register("requirement_parser", this::requirementParser);
        register("rag_search", this::ragSearch);
        register("code_generator", this::codeGenerator);
        register("test_generator", this::testGenerator);
        register("nacos_register", this::nacosRegister);
        register("sentinel_rule_push", this::sentinelRulePush);
        register("deploy_orchestrator", this::deployOrchestrator);
        register("evaluate_call", this::evaluateCall);
    }

    /** 工具 handler 接口：输入 Map → 输出 Map */
    @FunctionalInterface
    public interface ToolHandler {
        Map<String, Object> handle(Map<String, Object> input);
    }

    private void register(String name, ToolHandler handler) {
        dispatch.put(name, handler);
    }

    /** 调用工具 */
    public Map<String, Object> call(String toolName, Map<String, Object> input) {
        ToolHandler handler = dispatch.get(toolName);
        if (handler == null) throw new IllegalArgumentException("未知工具: " + toolName);
        return handler.handle(input);
    }

    // ============ 8 个工具 handler（空壳，带 TODO 标实现点）============

    /** 工具1：解析需求成 OpenAPI 3.0 + NFR */
    private Map<String, Object> requirementParser(Map<String, Object> input) {
        // TODO: 调 LLM（Prompt 在 Nacos firefly-main-prompt.yml 热更）解析自然语言→OpenAPI
        // TODO: SLA 解析成 NFR {qps, latency_p99, consistency_level}
        // TODO: 3次失败→status=failed + clarification_questions 回问业务方
        String reqId = (String) input.get("requirement_id");
        Map<String, Object> openapi = Map.of("openapi", "3.0.0", "paths", Map.of());
        Map<String, Object> nfr = Map.of("qps", 1000, "latency_p99", 200);
        jdbc.update("UPDATE interface_requirement SET openapi_spec=?, nfr=?, status='generating' WHERE id=?",
                new com.fasterxml.jackson.databind.ObjectMapper().valueToTree(openapi),
                new com.fasterxml.jackson.databind.ObjectMapper().valueToTree(nfr),
                reqId);
        return Map.of("requirement_id", reqId, "openapi", openapi, "nfr", nfr, "status", "generating");
    }

    /** 工具2：RAG 检索相似实现/规范/缺陷（混合检索：向量+BM25+RRF+Rerank） */
    private Map<String, Object> ragSearch(Map<String, Object> input) {
        // TODO: 并行调 Milvus(向量 Top50) + ES(BM25 Top50) → RRF融合 → 连坐召回 → Rerank Top20
        // TODO: filters: {domain, type:[implementation,spec,defect_case]}
        // TODO: 向量库超时→降级仅 BM25，写 degradation_log
        return Map.of("rag_context", List.of(), "degraded", false);
    }

    /** 工具3：生成 Spring Boot 全套代码（派发 codegen_subagent 按层并行） */
    private Map<String, Object> codeGenerator(Map<String, Object> input) {
        // TODO: 派发 codegen_subagent(task)，4个子Agent分别生成 Controller/Service/Mapper+SQL/DTO+Config
        // TODO: 聚合校验 mvn compile → 算 content_hash → 写 code_manifest
        // TODO: 失败重试2次；编译失败回工具2补 RAG 上下文重新生成
        String reqId = (String) input.get("requirement_id");
        return Map.of("requirement_id", reqId, "files", List.of(), "version", "0.1.0", "status", "testing");
    }

    /** 工具4：生成测试 + 卡覆盖率≥80% */
    private Map<String, Object> testGenerator(Map<String, Object> input) {
        // TODO: 派发 testgen_subagent(task) 生成 JUnit5+Mockito
        // TODO: 跑 mvn test + 收 JaCoCo 覆盖率
        // TODO: <80% 退回补测（最多3轮）；3轮不达标→降级70%放行但告警
        return Map.of("coverage", 0.85, "passed", true, "status", "deploying");
    }

    /** 工具5：注册新接口服务到 Nacos */
    private Map<String, Object> nacosRegister(Map<String, Object> input) {
        // TODO: 调 Nacos OpenAPI 注册实例 {service_name, ip, port, metadata:{domain,version}}
        // TODO: 注册失败重试3次（指数退避）→告警
        return Map.of("instance_id", "inst-" + System.currentTimeMillis(), "registered", true);
    }

    /** 工具6：推送 Sentinel 限流规则（按 API 重要级） */
    private Map<String, Object> sentinelRulePush(Map<String, Object> input) {
        // TODO: 秒杀接口 QPS 10000 / 普通CRUD 线程数200 / 支付回调 QPS 500
        // TODO: 规则持久化到 Nacos firefly-sentinel-rules.json 热更
        return Map.of("rule_id", "rule-" + System.currentTimeMillis(), "pushed", true);
    }

    /** 工具7：灰度部署 5%→50%→100%（派发 deploy_subagent teammate） */
    private Map<String, Object> deployOrchestrator(Map<String, Object> input) {
        // TODO: 派发 deploy_subagent(teammate 持久)，通过收件箱回报每阶段状态
        // TODO: 每阶段观察N分钟（firefly-canary-strategy.yml），健康度达标才进下一档
        // TODO: 任一阶段不达标→自动回滚上一 tag，通知升级Agent
        return Map.of("canary_pct", 5, "status", "5", "healthy", true);
    }

    /** 工具8：同步调侦察评估（触发主力→侦察握手） */
    private Map<String, Object> evaluateCall(Map<String, Object> input) {
        // TODO: gRPC/HTTP 调侦察 EvaluateService.Evaluate(service, version, metrics_window_sec=300)
        // TODO: 超时5s→降级用本地缓存基线，异步补调
        return Map.of("score", 0.92, "trend", "flat");
    }

    /** 触发生成流水线（功能1→6） */
    public void triggerPipeline(String requirementId) {
        // 异步执行，不阻塞 HTTP 请求
        new Thread(() -> {
            try {
                Map<String, Object> ctx = new HashMap<>();
                ctx.put("requirement_id", requirementId);
                call("requirement_parser", ctx);
                call("rag_search", ctx);
                call("code_generator", ctx);
                call("test_generator", ctx);
                call("nacos_register", ctx);
                call("sentinel_rule_push", ctx);
                call("deploy_orchestrator", ctx);
            } catch (Exception e) {
                jdbc.update("UPDATE interface_requirement SET status='failed' WHERE id=?", requirementId);
            }
        }, "pipeline-" + requirementId).start();
    }
}
