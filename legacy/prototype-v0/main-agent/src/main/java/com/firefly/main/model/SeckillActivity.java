package com.firefly.main.model;

import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

/** 秒杀活动（业务实体） */
@Data
public class SeckillActivity {
    private String id;
    private String courseId;
    private BigDecimal originPrice;
    private BigDecimal seckillPrice;
    private Integer stock;
    private Integer perUserLimit;
    private LocalDateTime startTime;
    private LocalDateTime endTime;
    /** not_started/running/ended/sold_out */
    private String status;
}
