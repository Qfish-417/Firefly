package com.firefly.main.model;

import lombok.Data;
import java.time.LocalDateTime;

/** 代码产出清单（一次生成的全套文件 + 覆盖率 + git_tag） */
@Data
public class CodeManifest {
    private String id;
    private String requirementId;
    private String version;
    /** JSON: [{path, layer, content_hash}] */
    private String files;
    private Double coverage;
    private String buildStatus;
    private String gitTag;
    private LocalDateTime createdAt;
}
