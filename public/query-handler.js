// 查询处理函数

// 主查询函数
async function handleQuery() {
  const question = document.getElementById('queryInput').value.trim();
  
  if (!question) {
    return;
  }

  const embeddingModel = document.getElementById('queryEmbeddingModel').value;
  const llmModel = document.getElementById('queryLLMModel').value;
  const streamMode = document.getElementById('streamMode').value;
  const queryBtn = document.getElementById('queryBtn');
  const queryResult = document.getElementById('queryResult');

  queryBtn.disabled = true;
  queryResult.innerHTML = '<div class="status info">思考中<span class="loading"></span></div>';

  try {
    if (streamMode === 'stream') {
      // 流式响应
      await handleQueryStream(question, embeddingModel, llmModel);
    } else {
      // 普通响应
      await handleQueryNormal(question, embeddingModel, llmModel);
    }
  } catch (error) {
    queryResult.innerHTML = `<div class="status error">✗ 查询失败：${error.message}</div>`;
  } finally {
    queryBtn.disabled = false;
  }
}

// 普通响应（非流式）
async function handleQueryNormal(question, embeddingModel, llmModel) {
  const queryResult = document.getElementById('queryResult');
  
  const response = await fetch(`${API_BASE}/api/query`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ 
      question, 
      topK: 5,
      embeddingModel,
      llmModel,
    }),
  });

  const data = await response.json();

  if (response.ok) {
    displayAnswer(data.answer, data.sources, data.fromKnowledgeBase);
  } else {
    queryResult.innerHTML = `<div class="status error">✗ 查询失败：${data.error}</div>`;
  }
}

// 流式响应
async function handleQueryStream(question, embeddingModel, llmModel) {
  const queryResult = document.getElementById('queryResult');
  
  const response = await fetch(`${API_BASE}/api/query/stream`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ 
      question, 
      topK: 5,
      embeddingModel,
      llmModel,
    }),
  });

  if (!response.ok) {
    const data = await response.json();
    queryResult.innerHTML = `<div class="status error">✗ 查询失败：${data.error}</div>`;
    return;
  }

  // 读取流式响应
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let sources = [];
  let fromKnowledgeBase = false;

  while (true) {
    const { done, value } = await reader.read();
    
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    
    // 按行处理
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      if (trimmedLine === '' || !trimmedLine.startsWith('data: ')) {
        continue;
      }
      
      try {
        const jsonStr = trimmedLine.substring(6);
        const data = JSON.parse(jsonStr);
        
        if (data.type === 'sources') {
          // 收到 sources 信息
          sources = data.sources;
          fromKnowledgeBase = data.fromKnowledgeBase;
          
          // 初始化显示
          let html = '<div class="result"><strong>回答：</strong>';
          if (!fromKnowledgeBase) {
            html += `<div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 8px 12px; margin: 8px 0; color: #856404;">
              ⚠️ 知识库中未找到相关信息，以下回答基于模型的通用知识
            </div>`;
          }
          html += '<div class="answer-content" style="margin-top: 8px;"></div></div>';
          queryResult.innerHTML = html;
          
        } else if (data.type === 'content') {
          // 收到内容块
          answer += data.content;
          
          // 实时更新显示（纯文本，避免闪烁）
          const answerContent = queryResult.querySelector('.answer-content');
          if (answerContent) {
            answerContent.textContent = answer;
          }
          
        } else if (data.type === 'done') {
          // 完成，渲染最终结果
          displayAnswer(answer, sources, fromKnowledgeBase);
          
        } else if (data.type === 'error') {
          queryResult.innerHTML = `<div class="status error">✗ 查询失败：${data.error}</div>`;
        }
      } catch (e) {
        console.error('解析 SSE 数据失败:', e);
      }
    }
  }
}

// 显示答案（通用函数）
function displayAnswer(answer, sources, fromKnowledgeBase) {
  const queryResult = document.getElementById('queryResult');
  
  // 预处理：将 [...] 格式的公式转换为 $...$ 格式
  let processedAnswer = answer;
  
  // 转换块级公式
  processedAnswer = processedAnswer.replace(/\\\[([\s\S]*?)\\\]/g, (m, p1) => '$$' + p1 + '$$');
  processedAnswer = processedAnswer.replace(/\[([\s\S]*?)\]/g, (match, formula) => {
    if (/[\\{}^_=]|\\[a-zA-Z]+/.test(formula)) {
      return '$' + formula + '$';
    }
    return match;
  });
  
  // 转换行内公式
  processedAnswer = processedAnswer.replace(/\\\(([\s\S]*?)\\\)/g, (m, p1) => '$' + p1 + '$');
  
  // 保护公式：先提取公式，用占位符替换
  const mathBlocks = [];
  let protectedAnswer = processedAnswer;
  
  // 提取块级公式 $$...$$
  protectedAnswer = protectedAnswer.replace(/\$\$([\s\S]*?)\$\$/g, (match, formula) => {
    const index = mathBlocks.length;
    mathBlocks.push({ type: 'block', formula: formula });
    return `MATHBLOCK${index}ENDMATH`;
  });
  
  // 提取行内公式 $...$
  protectedAnswer = protectedAnswer.replace(/\$([^\$\n]+?)\$/g, (match, formula) => {
    const index = mathBlocks.length;
    mathBlocks.push({ type: 'inline', formula: formula });
    return `MATHINLINE${index}ENDMATH`;
  });
  
  // 用 marked 渲染 markdown
  let htmlContent;
  if (typeof marked !== 'undefined') {
    htmlContent = marked.parse(protectedAnswer);
  } else {
    htmlContent = protectedAnswer.replace(/\n/g, '<br>');
  }
  
  // 恢复公式
  mathBlocks.forEach((item, index) => {
    if (item.type === 'block') {
      htmlContent = htmlContent.replace(`MATHBLOCK${index}ENDMATH`, `$$${item.formula}$$`);
    } else {
      htmlContent = htmlContent.replace(`MATHINLINE${index}ENDMATH`, `$${item.formula}$`);
    }
  });
  
  let html = `<div class="result">
    <strong>回答：</strong>`;
  
  // 如果没有使用知识库，显示提示
  if (fromKnowledgeBase === false) {
    html += `<div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 8px 12px; margin: 8px 0; color: #856404;">
      ⚠️ 知识库中未找到相关信息，以下回答基于模型的通用知识
    </div>`;
  }
  
  html += `<div class="answer-content" style="margin-top: 8px;">${htmlContent}</div>`;

  if (sources && sources.length > 0) {
    html += `<div class="sources">
      <strong>参考来源：</strong>`;
    
    sources.forEach((source, idx) => {
      html += `<div class="source-item">
        <strong>${idx + 1}.</strong> ${source.fileName} (片段 ${source.chunkIndex + 1}, 相似度: ${(source.score * 100).toFixed(1)}%)
        <div style="color: #666; margin-top: 4px;">${source.preview}</div>
      </div>`;
    });

    html += `</div>`;
  }

  html += `</div>`;
  queryResult.innerHTML = html;
  
  // 渲染数学公式
  if (typeof renderMathInElement !== 'undefined') {
    const answerContent = queryResult.querySelector('.answer-content');
    if (answerContent) {
      renderMathInElement(answerContent, {
        delimiters: [
          {left: '$$', right: '$$', display: true},
          {left: '$', right: '$', display: false},
          {left: '\\[', right: '\\]', display: true},
          {left: '\\(', right: '\\)', display: false}
        ],
        throwOnError: false
      });
    }
  }
}
