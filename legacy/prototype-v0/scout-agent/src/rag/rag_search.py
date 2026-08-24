"""
RAG 混合检索（三 Agent 共用，设计文档 8.5）
架构：
  query
    ├─ 向量检索(Milvus) → 语义相似 Top50    # "库存扣减" ↔ "stock decrement"
    ├─ BM25 检索(ES)    → 关键词匹配 Top50   # "SeckillServiceImpl" "OUT_OF_STOCK"
    └─ RRF 融合         → 合并去重 Top50      # score = Σ 1/(60+rank)
         ↓
  连坐召回(命中切片拉父文档全部切片)         # 防摘要块霸榜
         ↓
  Rerank(bge-reranker-v2-m3) → Top20       # 精排，Recall@5 94%→99.3%
         ↓
  rag_context 返回给 Agent

三 Agent 用 RAG 的差异（filters 不同）：
- 主力: type=[implementation, spec, defect_case]  # 相似实现 few-shot
- 侦察: type=[defect_case, fix_case]               # 历史错误模式
- 升级: type=[fix_case, review_rule, failure_case] # 修复案例，failure_case 权重×1.5
"""
import os
from typing import List, Dict


class RagSearcher:
    def __init__(self):
        self.milvus_host = os.getenv("MILVUS_HOST", "localhost")
        self.es_host = os.getenv("ES_HOST", "localhost:9200")
        self._reranker = None  # 延迟加载 Reranker（重模型）

    def search(self, query: str, agent_name: str = "main",
               types: List[str] = None, domain: str = "",
               top_k: int = 20) -> Dict:
        """
        混合检索：向量 + BM25 + RRF + 连坐 + Rerank
        :return: {hits: [{content, score, source, type}], degraded: bool}
        """
        if types is None:
            types = ["implementation", "spec", "defect_case"]

        try:
            # 1. 向量检索（Milvus）
            vector_hits = self._vector_search(query, types, domain, top_k=50)
        except Exception as e:
            print(f"[RAG] 向量检索失败，降级仅 BM25: {e}")
            vector_hits = []

        try:
            # 2. BM25 检索（ES）
            bm25_hits = self._bm25_search(query, types, domain, top_k=50)
        except Exception as e:
            print(f"[RAG] BM25 检索失败: {e}")
            bm25_hits = []

        # 3. RRF 融合
        fused = self._rrf_fusion(vector_hits, bm25_hits)

        # 4. 连坐召回（命中切片拉父文档全部切片）
        expanded = self._sibling_recall(fused)

        # 5. Rerank 精排 Top50 → Top20
        reranked = self._rerank(query, expanded, top_k=top_k)

        degraded = len(vector_hits) == 0  # 向量库失败标记降级
        return {"hits": reranked, "degraded": degraded}

    def _vector_search(self, query, types, domain, top_k=50) -> List[Dict]:
        """向量检索（Milvus），抓语义相似"""
        # TODO: from pymilvus import connections, Collection
        # TODO: query_embedding = self._embed(query)
        # TODO: collection.search(query_embedding, filter expr, top_k)
        # 骨架返回空，实际接 Milvus
        return []

    def _bm25_search(self, query, types, domain, top_k=50) -> List[Dict]:
        """BM25 检索（ES），抓字面精确关键词"""
        # TODO: from elasticsearch import Elasticsearch
        # TODO: es.search(index="firefly_experience", body={query: {match: {content: query}}})
        return []

    def _rrf_fusion(self, vector_hits, bm25_hits, k=60) -> List[Dict]:
        """RRF 融合：score = Σ 1/(k+rank)，合并去重"""
        scores: Dict[str, float] = {}
        content_map: Dict[str, Dict] = {}
        for rank, hit in enumerate(vector_hits):
            key = hit.get("source", hit.get("content", ""))[:100]
            scores[key] = scores.get(key, 0) + 1.0 / (k + rank + 1)
            content_map[key] = hit
        for rank, hit in enumerate(bm25_hits):
            key = hit.get("source", hit.get("content", ""))[:100]
            scores[key] = scores.get(key, 0) + 1.0 / (k + rank + 1)
            content_map[key] = hit
        # 按融合分数排序
        sorted_keys = sorted(scores.items(), key=lambda x: -x[1])
        result = []
        for key, score in sorted_keys[:50]:
            hit = dict(content_map[key])
            hit["score"] = round(score, 6)
            result.append(hit)
        return result

    def _sibling_recall(self, hits: List[Dict]) -> List[Dict]:
        """连坐召回：命中切片拉父文档全部切片，防摘要块霸榜"""
        # TODO: 据每条 hit 的 parent_id 拉同父文档的其他切片
        # 骨架：直接返回原列表
        return hits

    def _rerank(self, query: str, hits: List[Dict], top_k: int = 20) -> List[Dict]:
        """Rerank 精排（bge-reranker-v2-m3）"""
        if not hits:
            return []
        try:
            # TODO: 延迟加载 FlagEmbedding reranker
            # from FlagEmbedding import FlagReranker
            # if self._reranker is None:
            #     self._reranker = FlagReranker('BAAI/bge-reranker-v2-m3', use_fp16=True)
            # pairs = [[query, h["content"]] for h in hits]
            # scores = self._reranker.compute_score(pairs)
            # 排序取 top_k
            pass
        except Exception as e:
            print(f"[RAG] Rerank 失败，用原序: {e}")
        return hits[:top_k]

    def _embed(self, text: str) -> List[float]:
        """文本向量化（sentence-transformers）"""
        # TODO: from sentence_transformers import SentenceTransformer
        # 模型必须先锁再入库，不能随意换（换模型要重建索引）
        # model = SentenceTransformer('BAAI/bge-large-zh-v1.5')
        # return model.encode(text).tolist()
        return []
