package com.firefly.main.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 健康检查与指标暴露（功能 7）
 * /health 给 Nacos 心跳 / 升级灰度判断
 * /actuator/prometheus 给侦察拉指标（application.yml 已暴露）
 */
@RestController
public class HealthController {
    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of(
                "status", "UP",
                "service", "firefly-main-agent",
                "version", "0.1.0",
                "timestamp", System.currentTimeMillis()
        );
    }
}
