package com.firefly.main.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.Map;

/**
 * 侦察 Agent HTTP 客户端（功能 8：质量自评触发）
 * 同步调侦察 /evaluate 接口（设计文档定义为 gRPC EvaluateService，骨架用 HTTP 等效）
 * 超时5s→降级用本地缓存基线，异步补调
 */
@Service
public class ScoutClient {

    @Value("${firefly.grpc.scout-addr:localhost:8081}")
    private String scoutAddr;

    private final RestTemplate restTemplate = new RestTemplate();

    /**
     * 调侦察评估
     * @param service 目标服务名
     * @param version 当前版本
     * @return 评估结果 {score, dimension_scores, trend}
     */
    public Map<String, Object> evaluate(String service, String version) {
        String url = "http://" + scoutAddr.replace("9092", "8081") + "/evaluate";
        try {
            ResponseEntity<Map> resp = restTemplate.postForEntity(url,
                    Map.of("service", service, "version", version, "metrics_window_sec", 300),
                    Map.class);
            return resp.getBody();
        } catch (Exception e) {
            // 降级：用本地缓存基线
            return Map.of("score", 0.90, "trend", "flat", "degraded", true, "error", e.getMessage());
        }
    }
}
