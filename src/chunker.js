// 文本分块工具
export class TextChunker {
  constructor(chunkSize = 400, overlap = 40) {
    this.chunkSize = chunkSize;
    this.overlap = overlap;
  }

  // 将文本分块
  chunk(text) {
    const chunks = [];
    const sentences = this.splitIntoSentences(text);
    
    let currentChunk = '';
    let currentLength = 0;
    
    for (const sentence of sentences) {
      const sentenceLength = sentence.length;
      
      if (currentLength + sentenceLength > this.chunkSize && currentChunk) {
        chunks.push(currentChunk.trim());
        
        // 保留重叠部分
        const words = currentChunk.split(' ');
        const overlapWords = words.slice(-Math.floor(this.overlap / 5));
        currentChunk = overlapWords.join(' ') + ' ';
        currentLength = currentChunk.length;
      }
      
      currentChunk += sentence + ' ';
      currentLength += sentenceLength + 1;
    }
    
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }

  // 简单的句子分割
  splitIntoSentences(text) {
    return text
      .replace(/([.!?。！？])\s+/g, '$1|')
      .split('|')
      .filter(s => s.trim().length > 0);
  }
}
