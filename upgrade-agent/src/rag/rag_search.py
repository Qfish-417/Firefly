"""
RAG 混合检索（升级 Agent 用，与 shared/rag 对齐）
升级检索时 failure_case 权重 ×1.5，避免重复踩坑
架构同侦察：向量(Milvus) + BM25(ES) + RRF + 连坐 + Rerank
"""
import os
from typing import List, Dict


class RagSearcher:
    def __init__(self):
        self.milvus_host = os.getenv("MILVUS_HOST", "localhost")
        self.es_host = os.getenv("ES_HOST", "localhost:9200")

    def search(self, query: str, agent_name: str = "upgrade",
               types: List[str] = None, domain: str = "",
               top_k: int = 20) -> Dict:
        if types is None:
            types = ["fix_case", "review_rule", "failure_case"]
        try:
            vector_hits = self._vector_search(query, types, domain, top_k=50)
        except Exception as e:
            print(f"[RAG] 向量检索失败，降级仅 BM25: {e}")
            vector_hits = []
        try:
            bm25_hits = self._bm25_search(query, types, domain, top_k=50)
        except Exception as e:
            print(f"[RAG] BM25 检索失败: {e}")
            bm25_hits = []
        fused = self._rrf_fusion(vector_hits, bm25_hits)
        # 升级特有：failure_case 权重 ×1.5，优先避免重蹈覆辙
        for h in fused:
            if h.get("type") == "failure_case":
                h["score"] = h.get("score", 0) * 1.5
        fused.sort(key=lambda x: -x.get("score", 0))
        reranked = self._rerank(query, fused, top_k=top_k)
        return {"hits": reranked, "degraded": len(vector_hits) == 0}

    def _vector_search(self, query, types, domain, top_k=50) -> List[Dict]:
        # TODO: pymilvus 向量检索
        return []

    def _bm25_search(self, query, types, domain, top_k=50) -> List[Dict]:
        # TODO: elasticsearch BM25 检索
        return []

    def _rrf_fusion(self, vector_hits, bm25_hits, k=60) -> List[Dict]:
        scores: Dict[str, float] = {}
        content_map: Dict[str, Dict] = {}
        for rank, hit in enumerate(vector_hits + bm25_hits):
            key = hit.get("source", hit.get("content", ""))[:100]
            scores[key] = scores.get(key, 0) + 1.0 / (k + rank + 1)
            content_map[key] = hit
        sorted_keys = sorted(scores.items(), key=lambda x: -x[1])
        result = []
        for key, score in sorted_keys[:50]:
            hit = dict(content_map[key]); hit["score"] = round(score, 6)
            result.append(hit)
        return result

    def _rerank(self, query: str, hits: List[Dict], top_k: int = 20) -> List[Dict]:
        # TODO: bge-reranker-v2-m3 精排
        return hits[:top_k]
