"""
FireFly RAG 索引构建脚本（设计文档 8.5，RAG 八环流水线）
数据源 → 清洗 → 元数据增强 → 分块 → Embedding → 入库(Milvus+ES) → 数据闭环

八环（源自乐享《RAG 知识库建设实战》）：
1. 清洗(正则40+条，占工时65%)
2. 元数据增强(摘要+术语+可答问题，HyDE)
3. 分块(短不切/长chunk6000)
4. Embedding(先锁模型再入库，不能随意换)
5. 混合召回(向量+BM25)  ← 检索时执行，见 rag_search.py
6. 连坐召回(命中切片拉父文档)  ← 检索时执行
7. Rerank(bge-reranker-v2-m3)  ← 检索时执行
8. 数据闭环(埋点+点踩+反哺基线)

本脚本负责 1-4 环（入库），检索环节在 rag_search.py
"""
import os
import re
import json
import hashlib
from typing import List, Dict


# ============ 1. 清洗 ============
# 正则清洗规则（占工时65%，需根据数据源定制）
CLEAN_RULES = [
    (r"```[\s\S]*?```", ""),          # 去代码块（按需保留）
    (r"<!--[\s\S]*?-->", ""),          # 去 HTML 注释
    (r"\r\n", "\n"),                   # 统一换行
    (r"\n{3,}", "\n\n"),               # 压缩多余空行
    (r"^\s*[|\-]+\s*$", "", re.M),     # 去 markdown 分隔线
    (r"https?://\S+", ""),             # 去纯链接（按需）
]


def clean_text(text: str) -> str:
    """清洗文本（正则规则逐条应用）"""
    for rule in CLEAN_RULES:
        pattern = rule[0] if isinstance(rule, tuple) and len(rule) == 2 else rule
        repl = rule[1] if len(rule) > 1 else ""
        flags = rule[2] if len(rule) > 2 else 0
        text = re.sub(pattern, repl, text, flags=flags)
    return text.strip()


# ============ 2. 元数据增强 ============
def enrich_metadata(chunk: Dict) -> Dict:
    """元数据增强：摘要 + 术语 + 可答问题（HyDE）
    提升检索召回率，防摘要块霸榜"""
    content = chunk.get("content", "")
    # TODO: 调 LLM 生成摘要/术语/可答问题（HyDE: Hypothetical Document Embedding）
    chunk["metadata"] = {
        "summary": content[:100],          # 简化：取前100字（TODO: LLM 摘要）
        "terms": re.findall(r"[A-Za-z_][A-Za-z0-9_]+", content)[:10],  # 提取术语
        "domain": chunk.get("domain", "general"),
        "type": chunk.get("type", "implementation"),
        "content_hash": hashlib.md5(content.encode()).hexdigest(),
    }
    return chunk


# ============ 3. 分块 ============
def chunk_document(doc: Dict, max_chunk=6000, min_chunk=200) -> List[Dict]:
    """分块：短文档不切，长文档按 chunk_size 切
    设计文档：短不切/长chunk6000"""
    content = doc.get("content", "")
    if len(content) <= max_chunk:
        return [{**doc, "content": content, "chunk_id": 0}]

    chunks = []
    # 按段落切，超长再按句切
    paragraphs = content.split("\n\n")
    current = ""
    chunk_id = 0
    for para in paragraphs:
        if len(current) + len(para) > max_chunk and len(current) >= min_chunk:
            chunks.append({**doc, "content": current, "chunk_id": chunk_id})
            chunk_id += 1
            current = para
        else:
            current = (current + "\n\n" + para).strip()
    if current:
        chunks.append({**doc, "content": current, "chunk_id": chunk_id})
    return chunks


# ============ 4. Embedding + 入库 ============
def embed_and_index(chunks: List[Dict]):
    """Embedding + 入库 Milvus(向量) + ES(BM25)
    关键：先锁模型再入库，不能随意换（换模型要重建索引）"""
    from sentence_transformers import SentenceTransformer
    # 锁定模型：BAAI/bge-large-zh-v1.5（换模型需重建索引！）
    model = SentenceTransformer("BAAI/bge-large-zh-v1.5")

    # 入 Milvus
    from pymilvus import connections, Collection, FieldSchema, CollectionSchema, DataType
    connections.connect(host=os.getenv("MILVUS_HOST", "localhost"), port="19530")
    # TODO: 建 collection（id/content/vector/metadata），批量插入

    # 入 ES（BM25 索引）
    from elasticsearch import Elasticsearch
    es = Elasticsearch(os.getenv("ES_HOST", "localhost:9200"))
    # TODO: 建 index firefly_experience，批量 index chunks

    for chunk in chunks:
        vector = model.encode(chunk["content"]).tolist()
        # TODO: milvus.insert({id, content, vector, metadata})
        # TODO: es.index(index="firefly_experience", body={content, metadata})
        print(f"[入库] chunk_{chunk['chunk_id']} hash={chunk['metadata']['content_hash'][:8]}")


# ============ 主流程 ============
def build_index(data_dir: str):
    """构建 RAG 索引主流程：清洗 → 元数据增强 → 分块 → 入库"""
    print(f"[RAG索引] 开始构建，数据源: {data_dir}")
    all_chunks = []
    for fname in os.listdir(data_dir):
        path = os.path.join(data_dir, fname)
        if not os.path.isfile(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()

        # 1. 清洗
        cleaned = clean_text(raw)
        # 2. 分块
        doc = {"content": cleaned, "source": fname,
               "domain": _guess_domain(fname), "type": _guess_type(fname)}
        chunks = chunk_document(doc)
        # 3. 元数据增强
        for c in chunks:
            enrich_metadata(c)
            all_chunks.append(c)

    print(f"[RAG索引] 共 {len(all_chunks)} 个 chunk")
    # 4. Embedding + 入库
    embed_and_index(all_chunks)
    print(f"[RAG索引] 构建完成")


def _guess_domain(fname: str) -> str:
    if "seckill" in fname.lower(): return "seckill"
    if "order" in fname.lower(): return "order"
    if "pay" in fname.lower(): return "pay"
    return "general"


def _guess_type(fname: str) -> str:
    if "spec" in fname.lower() or "规范" in fname: return "spec"
    if "case" in fname.lower() or "案例" in fname: return "defect_case"
    return "implementation"


if __name__ == "__main__":
    # 用法: python build_index.py /data/rag-source
    import sys
    src = sys.argv[1] if len(sys.argv) > 1 else "./rag-source"
    build_index(src)
