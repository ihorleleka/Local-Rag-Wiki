const STOPWORDS = new Set(['about', 'after', 'again', 'also', 'because', 'before', 'between', 'could', 'doing', 'from', 'have', 'into', 'just', 'like', 'make', 'more', 'need', 'should', 'than', 'that', 'then', 'there', 'these', 'this', 'those', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your'])

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function keywords(value) {
  const seen = new Set()
  return (normalize(value).toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || [])
    .filter(word => !STOPWORDS.has(word) && !seen.has(word) && seen.add(word))
    .slice(0, 12)
}

export function textFrom(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}
