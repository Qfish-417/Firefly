package com.firefly.main.model;

import lombok.Data;
import java.time.LocalDateTime;

/** 发布单（灰度状态 0→5→50→100，失败 rolled_back） */
@Data
public class Release {
    private String id;
    private String service;
    private String version;
    private String manifestId;
    /** canary/blue_green */
    private String strategy;
    /** 0/5/50/100 */
    private Integer canaryPct;
    /** 0/5/50/100/rolled_back */
    private String status;
    private Double healthScore;
    private LocalDateTime createdAt;
}
