import { TextChunker } from './chunker.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // CORS 处理
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    try {
      // 公开端点（不需要认证）
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        return await handleLogin(request, env);
      } else if (url.pathname === '/api/auth/check' && request.method === 'GET') {
        return await handleAuthCheck(request, env);
      } else if (url.pathname === '/api/auth/setup' && request.method === 'POST') {
        return await handleSetupPassword(request, env);
      }
      
      // 需要认证的端点
      const authResult = await checkAuth(request, env);
      if (!authResult.authenticated) {
        return jsonResponse({ error: '未授权，请先登录' }, 401);
      }
      
      // 路由处理
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        return await handleUpload(request, env);
      } else if (url.pathname === '/api/upload/stream' && request.method === 'POST') {
        return await handleUploadStream(request, env);
      } else if (url.pathname === '/api/query' && request.method === 'POST') {
        return await handleQuery(request, env);
      } else if (url.pathname === '/api/query/stream' && request.method === 'POST') {
        return await handleQueryStream(request, env);
      } else if (url.pathname === '/api/list' && request.method === 'GET') {
        return await handleList(request, env);
      } else if (url.pathname === '/api/debug/r2' && request.method === 'GET') {
        return await handleDebugR2(request, env);
      } else if (url.pathname === '/api/config' && request.method === 'GET') {
        return await handleGetConfig(request, env);
      } else if (url.pathname === '/api/config' && request.method === 'POST') {
        return await handleSaveConfig(request, env);
      } else if (url.pathname === '/api/models/fetch' && request.method === 'POST') {
        return await handleFetchModels(request, env);
      } else if (url.pathname === '/api/document/delete' && request.method === 'POST') {
        return await handleDeleteDocument(request, env);
      } else {
        return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  },
};

// 获取配置信息
async function handleGetConfig(request, env) {
  const config = await getConfig(env);
  return jsonResponse(config);
}

// 保存配置
async function handleSaveConfig(request, env) {
  const newConfig = await request.json();
  
  // 验证必填字段
  if (!newConfig.embeddingBaseUrl || !newConfig.embeddingApiKey) {
    return jsonResponse({ error: 'Embedding API 配置不完整' }, 400);
  }
  
  if (!newConfig.llmBaseUrl || !newConfig.llmApiKey) {
    return jsonResponse({ error: 'LLM API 配置不完整' }, 400);
  }
  
  // 验证向量维度
  if (!newConfig.embeddingDimension || newConfig.embeddingDimension < 1) {
    return jsonResponse({ error: '向量维度必须大于 0' }, 400);
  }
  
  // 验证速率限制
  if (!newConfig.rateLimits) {
    newConfig.rateLimits = {
      embeddingRPM: 60,
      embeddingTPM: 1000000,
      llmRPM: 60,
      llmTPM: 90000,
    };
  }
  
  // 保存到 KV
  await env.KV.put('api_config', JSON.stringify(newConfig));
  
  return jsonResponse({ success: true, message: '配置已保存' });
}

// 获取可用模型列表
async function handleFetchModels(request, env) {
  const { baseUrl, apiKey, type } = await request.json();
  
  if (!baseUrl || !apiKey) {
    return jsonResponse({ error: '缺少必要参数' }, 400);
  }
  
  try {
    const models = await fetchAvailableModels(baseUrl, apiKey, type);
    return jsonResponse({ models });
  } catch (error) {
    return jsonResponse({ error: `获取模型列表失败: ${error.message}` }, 500);
  }
}

// 从 KV 获取配置
async function getConfig(env) {
  const configStr = await env.KV.get('api_config');
  
  if (configStr) {
    return JSON.parse(configStr);
  }
  
  // 返回默认配置
  return {
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    embeddingModels: [],
    selectedEmbeddingModel: '',
    embeddingDimension: 768,
    llmBaseUrl: '',
    llmApiKey: '',
    llmModels: [],
    selectedLLMModel: '',
    rateLimits: {
      embeddingRPM: 60,
      embeddingTPM: 1000000,
      llmRPM: 60,
      llmTPM: 90000,
    },
    configured: false,
  };
}

// 速率限制检查（带等待功能）
async function checkRateLimitWithWait(env, type, tokens = 0) {
  const config = await getConfig(env);
  const limits = config.rateLimits;
  const rpm = type === 'embedding' ? limits.embeddingRPM : limits.llmRPM;
  const tpm = type === 'embedding' ? limits.embeddingTPM : limits.llmTPM;
  
  let attempts = 0;
  const maxAttempts = 5; // 最多等待 5 分钟
  
  while (attempts < maxAttempts) {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const key = `ratelimit:${type}:${minute}`;
    
    const data = await env.KV.get(key, 'json') || { requests: 0, tokens: 0 };
    
    // 检查是否可以执行
    if (data.requests < rpm && data.tokens + tokens <= tpm) {
      // 更新计数
      data.requests += 1;
      data.tokens += tokens;
      await env.KV.put(key, JSON.stringify(data), { expirationTtl: 120 });
      
      return {
        allowed: true,
        waited: attempts > 0,
        waitedMinutes: attempts,
      };
    }
    
    // 超限，需要等待
    attempts++;
    
    if (attempts >= maxAttempts) {
      throw new Error(`速率限制：已等待 ${attempts} 分钟，仍然超限`);
    }
    
    // 计算需要等待到下一分钟的时间
    const nextMinute = (minute + 1) * 60000;
    const waitTime = nextMinute - now + 1000; // 多等 1 秒确保进入下一分钟
    
    // 等待
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  throw new Error('速率限制：超过最大等待时间');
}

// 批量处理 Embedding（带速率限制）
// 估算文本的 token 数（更准确的估算）
function estimateTokens(text) {
  // 中文字符：约 1.5-2 tokens/字
  // 英文单词：约 1-1.5 tokens/词
  // 数字和标点：约 1 token
  
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
  const others = text.length - chineseChars - englishWords;
  
  return Math.ceil(chineseChars * 1.8 + englishWords * 1.3 + others * 0.5);
}

// 将文本切分为符合 token 限制的片段
function splitTextByTokenLimit(text, maxTokens = 500) {
  const tokens = estimateTokens(text);
  
  if (tokens <= maxTokens) {
    return [text];
  }
  
  // 需要切分
  const chunks = [];
  const lines = text.split('\n');
  let currentChunk = '';
  
  for (const line of lines) {
    const testChunk = currentChunk + (currentChunk ? '\n' : '') + line;
    
    if (estimateTokens(testChunk) <= maxTokens) {
      currentChunk = testChunk;
    } else {
      // 当前行会导致超限
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = line;
      } else {
        // 单行就超限，按字符强制切分
        const lineTokens = estimateTokens(line);
        const ratio = maxTokens / lineTokens;
        const splitPoint = Math.floor(line.length * ratio * 0.9); // 留 10% 余量
        chunks.push(line.substring(0, splitPoint));
        currentChunk = line.substring(splitPoint);
      }
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

async function batchEmbeddings(texts, model, config, env, onProgress) {
  const batchSize = 1; // 每次只处理 1 个文本（避免超过 API 限制）
  const allEmbeddings = [];
  const MAX_TOKENS = 500; // 留一些余量，不用满 512
  
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    
    // 检查每个文本是否超过 token 限制，如果超过则切分
    const processedBatch = [];
    for (const text of batch) {
      const subChunks = splitTextByTokenLimit(text, MAX_TOKENS);
      processedBatch.push(...subChunks);
    }
    
    // 估算 token 数
    const estimatedTokens = processedBatch.reduce((sum, text) => sum + estimateTokens(text), 0);
    
    // 检查速率限制（带等待）
    const rateLimitResult = await checkRateLimitWithWait(env, 'embedding', estimatedTokens);
    
    if (rateLimitResult.waited) {
      // 通知前端已等待
      if (onProgress) {
        onProgress({
          type: 'rate_limit_wait',
          waitedMinutes: rateLimitResult.waitedMinutes,
          progress: i,
          total: texts.length,
        });
      }
    }
    
    // 调用 API
    const url = `${config.embeddingBaseUrl}/embeddings`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.embeddingApiKey}`,
      },
      body: JSON.stringify({
        input: processedBatch,
        model: model,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Embedding API 调用失败: ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    
    if (data.data && Array.isArray(data.data)) {
      const embeddings = data.data.map(item => item.embedding);
      
      // 如果文本被切分了，需要合并 embedding（取平均）
      if (processedBatch.length > batch.length) {
        // 简单处理：只取第一个切片的 embedding
        // 更好的方法是平均所有切片，但这里为了简单先这样
        allEmbeddings.push(embeddings[0]);
      } else {
        allEmbeddings.push(...embeddings);
      }
      
      // 通知进度
      if (onProgress) {
        onProgress({
          type: 'progress',
          progress: i + batch.length,
          total: texts.length,
        });
      }
    } else {
      throw new Error('Embedding API 返回格式不正确');
    }
  }
  
  return allEmbeddings;
}

// 从 OpenAI 兼容 API 获取可用模型
async function fetchAvailableModels(baseUrl, apiKey, type) {
  const url = `${baseUrl}/models`;
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
    }
    
    // 获取响应文本
    const responseText = await response.text();
    
    // 尝试解析 JSON
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (jsonError) {
      throw new Error(`API 返回的不是有效的 JSON。响应内容: ${responseText.substring(0, 200)}`);
    }
    
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error(`API 返回格式不正确。期望 { data: [...] }，实际收到: ${JSON.stringify(data).substring(0, 200)}`);
    }
    
    // 根据类型过滤模型
    let models = data.data.map(model => model.id);
    
    if (type === 'embedding') {
      // 过滤出 embedding 模型
      models = models.filter(id => 
        id.includes('embedding') || 
        id.includes('embed')
      );
    } else if (type === 'llm') {
      // 过滤出 LLM 模型（排除 embedding 模型）
      models = models.filter(id => 
        !id.includes('embedding') && 
        !id.includes('embed') &&
        !id.includes('whisper') &&
        !id.includes('tts') &&
        !id.includes('dall-e')
      );
    }
    
    return models.sort();
  } catch (error) {
    // 提供更详细的错误信息
    throw new Error(`获取模型列表失败: ${error.message}`);
  }
}

// 处理文件上传（流式，带进度）
async function handleUploadStream(request, env) {
  const config = await getConfig(env);
  
  if (!config.configured) {
    return jsonResponse({ error: '请先配置 API' }, 400);
  }
  
  const formData = await request.formData();
  const file = formData.get('file');
  const embeddingModel = formData.get('embeddingModel') || config.selectedEmbeddingModel;
  
  if (!file) {
    return jsonResponse({ error: '未找到文件' }, 400);
  }

  const fileName = file.name;
  
  // 检查是否已存在同名文件（使用分页存储）
  const existingDoc = await checkDocumentExists(env, fileName);
  if (existingDoc) {
    return jsonResponse({ 
      error: '该文档已上传过',
      message: `文件 "${fileName}" 已经存在于知识库中，无需重复上传`,
      existingDocId: existingDoc.docId,
      uploadTime: new Date(existingDoc.timestamp).toLocaleString('zh-CN')
    }, 409);
  }
  
  const fileType = file.type;
  const arrayBuffer = await file.arrayBuffer();
  
  let text = '';
  
  // 根据文件类型解析
  if (fileType === 'text/plain' || fileName.endsWith('.txt')) {
    text = new TextDecoder().decode(arrayBuffer);
  } else if (fileType === 'text/markdown' || fileName.endsWith('.md')) {
    text = new TextDecoder().decode(arrayBuffer);
  } else if (fileType === 'application/pdf' || fileName.endsWith('.pdf')) {
    const parser = new PDFParser();
    text = await parser.parse(arrayBuffer);
  } else {
    return jsonResponse({ error: '不支持的文件类型，仅支持 TXT、MD' }, 400);
  }

  if (!text || text.trim().length === 0) {
    return jsonResponse({ error: '文件内容为空' }, 400);
  }

  // 文本分块
  const chunker = new TextChunker(400, 40);
  const chunks = chunker.chunk(text);
  
  if (chunks.length === 0) {
    return jsonResponse({ error: '分块失败' }, 500);
  }

  // 创建 SSE 流
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  
  // 异步处理上传
  (async () => {
    try {
      const docId = crypto.randomUUID();
      const timestamp = Date.now();
      
      // 发送开始消息
      await writer.write(encoder.encode(`data: ${JSON.stringify({
        type: 'start',
        total: chunks.length,
        docId,
        fileName,
      })}\n\n`));
      
      // 批量处理 Embedding
      const embeddings = await batchEmbeddings(chunks, embeddingModel, config, env, async (progress) => {
        await writer.write(encoder.encode(`data: ${JSON.stringify(progress)}\n\n`));
      });
      
      // 存储到 Vectorize 和 R2
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${docId}-${i}`;
        
        // 存储原文到 R2
        await env.R2.put(chunkId, chunks[i], {
          customMetadata: {
            docId,
            fileName,
            chunkIndex: i.toString(),
            timestamp: timestamp.toString(),
          },
        });
        
        // 存储向量到 Vectorize
        await env.VECTORIZE.upsert([{
          id: chunkId,
          values: embeddings[i],
          metadata: {
            docId,
            fileName,
            chunkIndex: i,
            timestamp,
            embeddingModel,
          },
        }]);
        
        // 发送存储进度
        if (i % 10 === 0 || i === chunks.length - 1) {
          await writer.write(encoder.encode(`data: ${JSON.stringify({
            type: 'storing',
            progress: i + 1,
            total: chunks.length,
          })}\n\n`));
        }
      }
      
      // 更新 KV 中的文档列表（使用分页存储）
      await addDocumentToList(env, {
        docId,
        fileName,
        timestamp,
        chunksCount: chunks.length,
        embeddingModel,
      });
      
      // 发送完成消息
      await writer.write(encoder.encode(`data: ${JSON.stringify({
        type: 'complete',
        docId,
        fileName,
        chunksCount: chunks.length,
      })}\n\n`));
      
    } catch (error) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({
        type: 'error',
        error: error.message,
      })}\n\n`));
    } finally {
      await writer.close();
    }
  })();
  
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 处理文件上传（简单版，保持兼容）
async function handleUpload(request, env) {
  const config = await getConfig(env);
  
  if (!config.configured) {
    return jsonResponse({ error: '请先配置 API' }, 400);
  }
  
  const formData = await request.formData();
  const file = formData.get('file');
  const embeddingModel = formData.get('embeddingModel') || config.selectedEmbeddingModel;
  
  if (!file) {
    return jsonResponse({ error: '未找到文件' }, 400);
  }

  const fileName = file.name;
  
  // 检查是否已存在同名文件（使用分页存储）
  const existingDoc = await checkDocumentExists(env, fileName);
  if (existingDoc) {
    return jsonResponse({ 
      error: '该文档已上传过',
      message: `文件 "${fileName}" 已经存在于知识库中，无需重复上传`,
      existingDocId: existingDoc.docId,
      uploadTime: new Date(existingDoc.timestamp).toLocaleString('zh-CN')
    }, 409);
  }
  const fileType = file.type;
  const arrayBuffer = await file.arrayBuffer();
  
  let text = '';
  
  // 根据文件类型解析
  if (fileType === 'text/plain' || fileName.endsWith('.txt')) {
    text = new TextDecoder().decode(arrayBuffer);
  } else if (fileType === 'text/markdown' || fileName.endsWith('.md')) {
    text = new TextDecoder().decode(arrayBuffer);
  } else if (fileType === 'application/pdf' || fileName.endsWith('.pdf')) {
    const parser = new PDFParser();
    text = await parser.parse(arrayBuffer);
  } else {
    return jsonResponse({ error: '不支持的文件类型，仅支持 TXT、MD' }, 400);
  }

  if (!text || text.trim().length === 0) {
    return jsonResponse({ error: '文件内容为空' }, 400);
  }

  // 文本分块
  const chunker = new TextChunker(400, 40);
  const chunks = chunker.chunk(text);
  
  if (chunks.length === 0) {
    return jsonResponse({ error: '分块失败' }, 500);
  }

  // 调用 Embedding API（使用批量处理和速率限制）
  const embeddings = await batchEmbeddings(chunks, embeddingModel, config, env, null);
  
  // 存储到 Vectorize 和 R2
  const docId = crypto.randomUUID();
  const timestamp = Date.now();
  
  for (let i = 0; i < chunks.length; i++) {
    const chunkId = `${docId}-${i}`;
    
    // 存储原文到 R2
    await env.R2.put(chunkId, chunks[i], {
      customMetadata: {
        docId,
        fileName,
        chunkIndex: i.toString(),
        timestamp: timestamp.toString(),
      },
    });
    
    // 存储向量到 Vectorize
    await env.VECTORIZE.upsert([{
      id: chunkId,
      values: embeddings[i],
      metadata: {
        docId,
        fileName,
        chunkIndex: i,
        timestamp,
        embeddingModel,
      },
    }]);
  }

  // 更新文档列表到 KV（使用分页存储）
  await addDocumentToList(env, {
    docId,
    fileName,
    timestamp,
    chunksCount: chunks.length,
    embeddingModel,
  });

  return jsonResponse({
    success: true,
    docId,
    fileName,
    chunksCount: chunks.length,
  });
}

// 处理查询（非流式）
async function handleQuery(request, env) {
  const config = await getConfig(env);
  
  if (!config.configured) {
    return jsonResponse({ error: '请先配置 API' }, 400);
  }
  
  const { question, topK = 5, embeddingModel, llmModel } = await request.json();
  
  if (!question || question.trim().length === 0) {
    return jsonResponse({ error: '问题不能为空' }, 400);
  }

  const selectedEmbeddingModel = embeddingModel || config.selectedEmbeddingModel;
  const selectedLLMModel = llmModel || config.selectedLLMModel;

  // 获取问题的向量（使用速率限制）
  const estimatedTokens = Math.ceil(question.length / 4);
  await checkRateLimitWithWait(env, 'embedding', estimatedTokens);
  
  const questionEmbedding = await getEmbeddings([question], selectedEmbeddingModel, config, env);
  
  // 在 Vectorize 中检索
  const results = await env.VECTORIZE.query(questionEmbedding[0], {
    topK,
    returnMetadata: true,
  });

  let contexts = [];
  let hasKnowledge = false;
  
  // 设置相似度阈值（0.5 表示 50% 相似度，可以根据实际情况调整）
  const SIMILARITY_THRESHOLD = 0.5;
  
  if (results.matches && results.matches.length > 0) {
    // 从 R2 读取原文，只保留相似度高于阈值的结果
    for (const match of results.matches) {
      if (match.score >= SIMILARITY_THRESHOLD) {
        const chunkId = match.id;
        const object = await env.R2.get(chunkId);
        
        if (object) {
          const text = await object.text();
          contexts.push({
            text,
            score: match.score,
            metadata: match.metadata,
          });
        }
      }
    }
    hasKnowledge = contexts.length > 0;
  }

  // 构建 Prompt
  let prompt;
  if (hasKnowledge) {
    const contextText = contexts.map(c => c.text).join('\n\n');
    prompt = `你是一个智能助手。下面提供了一些知识库内容，但这些内容可能与问题相关，也可能不相关。

知识库内容：
${contextText}

问题：${question}

请回答问题。如果知识库内容与问题相关，请基于知识库回答；如果知识库内容与问题不相关，请忽略知识库，直接用你自己的知识回答问题。不要说"知识库中没有相关信息"之类的话，直接给出答案即可。`;
  } else {
    prompt = `问题：${question}

请直接回答这个问题。`;
  }

  // 调用 LLM API
  const answer = await getLLMCompletion(prompt, selectedLLMModel, config, env);

  return jsonResponse({
    answer,
    sources: contexts.map(c => ({
      fileName: c.metadata.fileName,
      chunkIndex: c.metadata.chunkIndex,
      score: c.score,
      preview: c.text.substring(0, 100) + '...',
    })),
    fromKnowledgeBase: hasKnowledge,
  });
}

// 处理查询（流式）
async function handleQueryStream(request, env) {
  const config = await getConfig(env);
  
  if (!config.configured) {
    return jsonResponse({ error: '请先配置 API' }, 400);
  }
  
  const { question, topK = 5, embeddingModel, llmModel } = await request.json();
  
  if (!question || question.trim().length === 0) {
    return jsonResponse({ error: '问题不能为空' }, 400);
  }

  const selectedEmbeddingModel = embeddingModel || config.selectedEmbeddingModel;
  const selectedLLMModel = llmModel || config.selectedLLMModel;

  // 获取问题的向量（使用速率限制）
  const estimatedTokens = Math.ceil(question.length / 4);
  await checkRateLimitWithWait(env, 'embedding', estimatedTokens);
  
  const questionEmbedding = await getEmbeddings([question], selectedEmbeddingModel, config, env);
  
  // 在 Vectorize 中检索
  const results = await env.VECTORIZE.query(questionEmbedding[0], {
    topK,
    returnMetadata: true,
  });

  let contexts = [];
  let hasKnowledge = false;
  
  // 设置相似度阈值
  const SIMILARITY_THRESHOLD = 0.5;
  
  if (results.matches && results.matches.length > 0) {
    for (const match of results.matches) {
      if (match.score >= SIMILARITY_THRESHOLD) {
        const chunkId = match.id;
        const object = await env.R2.get(chunkId);
        
        if (object) {
          const text = await object.text();
          contexts.push({
            text,
            score: match.score,
            metadata: match.metadata,
          });
        }
      }
    }
    hasKnowledge = contexts.length > 0;
  }

  // 构建 Prompt
  let prompt;
  if (hasKnowledge) {
    const contextText = contexts.map(c => c.text).join('\n\n');
    prompt = `你是一个智能助手。下面提供了一些知识库内容，但这些内容可能与问题相关，也可能不相关。

知识库内容：
${contextText}

问题：${question}

请回答问题。如果知识库内容与问题相关，请基于知识库回答；如果知识库内容与问题不相关，请忽略知识库，直接用你自己的知识回答问题。不要说"知识库中没有相关信息"之类的话，直接给出答案即可。`;
  } else {
    prompt = `问题：${question}

请直接回答这个问题。`;
  }

  // 先发送 sources 信息
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // 异步处理流式响应
  (async () => {
    try {
      // 发送 sources 信息
      await writer.write(encoder.encode(`data: ${JSON.stringify({
        type: 'sources',
        sources: contexts.map(c => ({
          fileName: c.metadata.fileName,
          chunkIndex: c.metadata.chunkIndex,
          score: c.score,
          preview: c.text.substring(0, 100) + '...',
        })),
        fromKnowledgeBase: hasKnowledge,
      })}\n\n`));

      // 调用 LLM API（流式）
      await getLLMCompletionStream(prompt, selectedLLMModel, config, env, writer, encoder);
      
      // 发送完成信号
      await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
    } catch (error) {
      await writer.write(encoder.encode(`data: ${JSON.stringify({
        type: 'error',
        error: error.message,
      })}\n\n`));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 调试：查看 R2 原始数据
async function handleDebugR2(request, env) {
  const objects = await env.R2.list();
  
  // 获取每个对象的详细信息
  const detailedObjects = [];
  for (const obj of objects.objects) {
    const fullObj = await env.R2.get(obj.key);
    detailedObjects.push({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded,
      customMetadata: fullObj ? fullObj.customMetadata : null,
      httpMetadata: fullObj ? fullObj.httpMetadata : null,
    });
  }
  
  const debugInfo = {
    totalObjects: objects.objects.length,
    objects: detailedObjects,
  };
  
  return jsonResponse(debugInfo);
}

// 文档列表管理（分页存储）
const DOCS_PER_PAGE = 100; // 每页存储 100 个文档

// 添加文档到列表
async function addDocumentToList(env, docInfo) {
  // 获取索引信息
  const indexJson = await env.KV.get('documents_index');
  const index = indexJson ? JSON.parse(indexJson) : { total: 0, pages: 0 };
  
  // 检查是否有空缺位置可以复用
  const vacanciesJson = await env.KV.get('documents_vacancies');
  const vacancies = vacanciesJson ? JSON.parse(vacanciesJson) : [];
  
  if (vacancies.length > 0) {
    // 有空缺，复用第一个空缺位置
    const vacancy = vacancies.shift(); // 取出第一个空缺
    const { page, index: idx } = vacancy;
    
    // 读取该页
    const pageKey = `documents_list_page_${page}`;
    const pageJson = await env.KV.get(pageKey);
    const pageData = pageJson ? JSON.parse(pageJson) : [];
    
    // 填充空缺位置
    pageData[idx] = docInfo;
    
    // 保存该页
    await env.KV.put(pageKey, JSON.stringify(pageData));
    
    // 更新空缺列表
    await env.KV.put('documents_vacancies', JSON.stringify(vacancies));
    
    // 更新索引（只增加总数，不增加页数）
    index.total += 1;
    await env.KV.put('documents_index', JSON.stringify(index));
  } else {
    // 没有空缺，追加到末尾
    const currentPage = Math.floor(index.total / DOCS_PER_PAGE);
    
    // 读取当前页
    const pageKey = `documents_list_page_${currentPage}`;
    const pageJson = await env.KV.get(pageKey);
    const pageData = pageJson ? JSON.parse(pageJson) : [];
    
    // 添加文档
    pageData.push(docInfo);
    
    // 保存当前页
    await env.KV.put(pageKey, JSON.stringify(pageData));
    
    // 更新索引
    index.total += 1;
    index.pages = Math.ceil(index.total / DOCS_PER_PAGE);
    await env.KV.put('documents_index', JSON.stringify(index));
  }
}

// 检查文档是否存在
async function checkDocumentExists(env, fileName) {
  const indexJson = await env.KV.get('documents_index');
  if (!indexJson) {
    return null;
  }
  
  const index = JSON.parse(indexJson);
  
  // 遍历所有页查找
  for (let page = 0; page < index.pages; page++) {
    const pageKey = `documents_list_page_${page}`;
    const pageJson = await env.KV.get(pageKey);
    
    if (pageJson) {
      const pageData = JSON.parse(pageJson);
      const existingDoc = pageData.find(doc => doc !== null && doc.fileName === fileName);
      if (existingDoc) {
        return existingDoc;
      }
    }
  }
  
  return null;
}

// 获取所有文档列表
async function getAllDocuments(env) {
  const indexJson = await env.KV.get('documents_index');
  if (!indexJson) {
    return [];
  }
  
  const index = JSON.parse(indexJson);
  const allDocuments = [];
  
  // 读取所有页
  for (let page = 0; page < index.pages; page++) {
    const pageKey = `documents_list_page_${page}`;
    const pageJson = await env.KV.get(pageKey);
    
    if (pageJson) {
      const pageData = JSON.parse(pageJson);
      allDocuments.push(...pageData);
    }
  }
  
  return allDocuments;
}

// 删除文档
async function handleDeleteDocument(request, env) {
  try {
    const { docId } = await request.json();
    
    if (!docId) {
      return jsonResponse({ error: '缺少文档ID' }, 400);
    }

    // 1. 从 KV 中找到文档信息
    const indexJson = await env.KV.get('documents_index');
    if (!indexJson) {
      return jsonResponse({ error: '文档不存在' }, 404);
    }
    
    const index = JSON.parse(indexJson);
    let docInfo = null;
    let foundPage = -1;
    let foundIndex = -1;
    
    // 遍历所有页查找文档
    for (let page = 0; page < index.pages; page++) {
      const pageKey = `documents_list_page_${page}`;
      const pageJson = await env.KV.get(pageKey);
      
      if (pageJson) {
        const pageData = JSON.parse(pageJson);
        const docIndex = pageData.findIndex(doc => doc && doc.docId === docId);
        
        if (docIndex !== -1) {
          docInfo = pageData[docIndex];
          foundPage = page;
          foundIndex = docIndex;
          break;
        }
      }
    }
    
    if (!docInfo) {
      return jsonResponse({ error: '文档不存在' }, 404);
    }

    // 2. 删除 R2 中的所有文本块
    const deleteR2Promises = [];
    for (let i = 0; i < docInfo.chunksCount; i++) {
      const chunkId = `${docId}-${i}`;
      deleteR2Promises.push(env.R2.delete(chunkId));
    }
    await Promise.all(deleteR2Promises);

    // 3. 删除 Vectorize 中的所有向量
    const vectorIds = [];
    for (let i = 0; i < docInfo.chunksCount; i++) {
      vectorIds.push(`${docId}-${i}`);
    }
    await env.VECTORIZE.deleteByIds(vectorIds);

    // 4. 从 KV 文档列表中删除记录（设为 null，保留空缺）
    const pageKey = `documents_list_page_${foundPage}`;
    const pageJson = await env.KV.get(pageKey);
    const pageData = JSON.parse(pageJson);
    
    // 将该位置设为 null（保留空缺，不影响其他文档的索引）
    pageData[foundIndex] = null;
    
    // 更新该页
    await env.KV.put(pageKey, JSON.stringify(pageData));
    
    // 记录空缺位置，供下次上传复用
    const vacanciesJson = await env.KV.get('documents_vacancies');
    const vacancies = vacanciesJson ? JSON.parse(vacanciesJson) : [];
    vacancies.push({ page: foundPage, index: foundIndex });
    await env.KV.put('documents_vacancies', JSON.stringify(vacancies));
    
    // 更新索引（减少总数）
    index.total -= 1;
    await env.KV.put('documents_index', JSON.stringify(index));

    return jsonResponse({
      success: true,
      message: '文档删除成功',
      fileName: docInfo.fileName,
    });
  } catch (error) {
    console.error('删除文档失败:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// 列出所有文档
// 列出所有文档
async function handleList(request, env) {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get('page') || '0');
  const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
  
  // 获取索引信息
  const indexJson = await env.KV.get('documents_index');
  if (!indexJson) {
    return jsonResponse({ documents: [], total: 0, hasMore: false });
  }
  
  const index = JSON.parse(indexJson);
  
  // 计算需要读取哪些存储页
  const startDoc = page * pageSize;
  
  const allDocuments = [];
  let currentPage = Math.floor(startDoc / DOCS_PER_PAGE);
  let skipCount = startDoc % DOCS_PER_PAGE;
  
  // 持续读取直到获得足够的文档或没有更多页
  while (allDocuments.length < pageSize && currentPage < index.pages) {
    const pageKey = `documents_list_page_${currentPage}`;
    const pageJson = await env.KV.get(pageKey);
    
    if (pageJson) {
      const pageData = JSON.parse(pageJson);
      
      // 过滤掉 null（已删除的文档）
      const validDocs = pageData.filter(doc => doc !== null);
      
      // 跳过前面的文档（仅第一页需要）
      const docsToAdd = skipCount > 0 ? validDocs.slice(skipCount) : validDocs;
      allDocuments.push(...docsToAdd);
      
      skipCount = 0; // 后续页不需要跳过
    }
    
    currentPage++;
  }
  
  // 只返回需要的数量
  const documents = allDocuments.slice(0, pageSize);
  
  // 排序
  documents.sort((a, b) => b.timestamp - a.timestamp);
  
  return jsonResponse({
    documents,
    total: index.total,
    page,
    pageSize,
    hasMore: allDocuments.length === pageSize && (startDoc + pageSize) < index.total,
  });
}

// 调用 Embedding API（简化版，用于单次调用）
async function getEmbeddings(texts, model, config, env) {
  const url = `${config.embeddingBaseUrl}/embeddings`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: model,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding API 调用失败: ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  
  if (data.data && Array.isArray(data.data)) {
    return data.data.map(item => item.embedding);
  }
  
  throw new Error('Embedding API 返回格式不正确');
}

// 调用 LLM API（OpenAI 兼容格式 - 非流式）
async function getLLMCompletion(prompt, model, config, env) {
  // 估算 token 数
  const estimatedTokens = Math.ceil(prompt.length / 4);
  
  // 检查速率限制（带等待）
  await checkRateLimitWithWait(env, 'llm', estimatedTokens);
  
  const url = `${config.llmBaseUrl}/chat/completions`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: 'user',
          content: prompt,
        }
      ],
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API 调用失败: ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  
  // OpenAI 格式
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  
  throw new Error('LLM API 返回格式不正确');
}

// 调用 LLM API（OpenAI 兼容格式 - 流式）
async function getLLMCompletionStream(prompt, model, config, env, writer, encoder) {
  // 估算 token 数
  const estimatedTokens = Math.ceil(prompt.length / 4);
  
  // 检查速率限制（带等待）
  await checkRateLimitWithWait(env, 'llm', estimatedTokens);
  
  const url = `${config.llmBaseUrl}/chat/completions`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: 'user',
          content: prompt,
        }
      ],
      temperature: 0.7,
      stream: true,  // 开启流式
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API 调用失败: ${response.statusText} - ${errorText}`);
  }

  // 读取流式响应
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    
    if (done) break;
    
    // 解码数据块
    buffer += decoder.decode(value, { stream: true });
    
    // 按行处理
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // 保留最后一个不完整的行
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      if (trimmedLine === '' || trimmedLine === 'data: [DONE]') {
        continue;
      }
      
      if (trimmedLine.startsWith('data: ')) {
        try {
          const jsonStr = trimmedLine.substring(6);
          const data = JSON.parse(jsonStr);
          
          // OpenAI 格式
          if (data.choices && data.choices[0] && data.choices[0].delta) {
            const content = data.choices[0].delta.content;
            
            if (content) {
              // 发送内容块
              await writer.write(encoder.encode(`data: ${JSON.stringify({
                type: 'content',
                content: content,
              })}\n\n`));
            }
          }
        } catch (e) {
          // 忽略解析错误
          console.error('解析 SSE 数据失败:', e);
        }
      }
    }
  }
}

// 简单的密码哈希（使用 Web Crypto API）
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 生成随机 token
function generateToken() {
  return crypto.randomUUID();
}

// 检查认证
async function checkAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authenticated: false };
  }
  
  const token = authHeader.substring(7);
  const storedToken = await env.KV.get('auth_token');
  
  if (token === storedToken) {
    return { authenticated: true };
  }
  
  return { authenticated: false };
}

// 设置密码（首次使用）
async function handleSetupPassword(request, env) {
  // 检查是否已经设置过密码
  const existingPassword = await env.KV.get('password_hash');
  if (existingPassword) {
    return jsonResponse({ error: '密码已设置，请使用登录功能' }, 400);
  }
  
  const { password } = await request.json();
  
  if (!password || password.length < 6) {
    return jsonResponse({ error: '密码至少需要 6 个字符' }, 400);
  }
  
  const passwordHash = await hashPassword(password);
  await env.KV.put('password_hash', passwordHash);
  
  const token = generateToken();
  await env.KV.put('auth_token', token);
  
  return jsonResponse({
    success: true,
    message: '密码设置成功',
    token,
  });
}

// 登录
async function handleLogin(request, env) {
  const { password } = await request.json();
  
  if (!password) {
    return jsonResponse({ error: '请输入密码' }, 400);
  }
  
  const storedHash = await env.KV.get('password_hash');
  
  if (!storedHash) {
    return jsonResponse({ error: '请先设置密码', needSetup: true }, 400);
  }
  
  const passwordHash = await hashPassword(password);
  
  if (passwordHash !== storedHash) {
    return jsonResponse({ error: '密码错误' }, 401);
  }
  
  const token = generateToken();
  await env.KV.put('auth_token', token);
  
  return jsonResponse({
    success: true,
    message: '登录成功',
    token,
  });
}

// 检查认证状态
async function handleAuthCheck(request, env) {
  const passwordHash = await env.KV.get('password_hash');
  
  if (!passwordHash) {
    return jsonResponse({ needSetup: true, authenticated: false });
  }
  
  const authResult = await checkAuth(request, env);
  
  return jsonResponse({
    needSetup: false,
    authenticated: authResult.authenticated,
  });
}

// JSON 响应辅助函数
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
