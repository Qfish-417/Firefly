package com.firefly.main;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.client.discovery.EnableDiscoveryClient;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * FireFly 主力 Agent 启动类
 * 业务编排者：把接口需求变成线上 API 服务，并 7×24 承接学员流量
 * 唯一对外的 agent，注册 Nacos，集成 Sentinel 限流
 */
@SpringBootApplication
@EnableDiscoveryClient
@EnableScheduling
public class FireFlyMainApplication {
    public static void main(String[] args) {
        SpringApplication.run(FireFlyMainApplication.class, args);
    }
}
