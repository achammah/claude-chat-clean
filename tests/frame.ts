// Turns a drawn tree (plain data, as `ui.drawn()` returns it) into text, so a reader can see
// what the owner will see. An approximation of the layout, not Ink's paint:
// a column stacks its children, a row sets them side by side with its gap, padding indents,
// marginTop adds a blank line, a plain Button is `k: label` with a hotkey or the label alone,
// an Svg is `[svg: alt]`. Text drawn in a colour is wrapped «like this».

type Node = string | { type: string; props?: Record<string, unknown>; children?: Node[] }

const len = (s: string) => [...s].length
const padTo = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - len(s)))
const cut = (s: string, w: number) => (len(s) > w ? [...s].slice(0, Math.max(0, w - 1)).join('') + '…' : s)

function inline(n: Node): string {
  if (typeof n === 'string') return n
  const p = n.props ?? {}
  if (n.type === 'Button') {
    const label = String(p.label ?? '')
    if (p.plain) return p.hotkey ? `${p.hotkey}: ${label}` : label
    return `[ ${label} ]`
  }
  if (n.type === 'Svg') return `[svg: ${String(p.alt ?? '')}]`
  const body = (n.children ?? []).map(inline).join('')
  // a bar's dim (empty) part, which plain text cannot show as dim
  if (n.type === 'Text' && p.dimColor && /^━+$/.test(body)) return '─'.repeat(len(body))
  return n.type === 'Text' && typeof p.color === 'string' ? `«${body}»` : body
}

function lines(n: Node, width: number): string[] {
  if (typeof n === 'string') return [n]
  const p = n.props ?? {}
  if (p.display === 'none') return []
  if (n.type !== 'Box') return [inline(n)]
  const kids = ((n.children ?? []) as unknown[]).filter(c => c !== null && c !== undefined && c !== false) as Node[]
  const padL = Number(p.paddingLeft ?? p.paddingX ?? p.padding ?? 0)
  const inner = Math.max(1, width - padL)
  let out: string[]
  if (p.flexDirection === 'row') {
    const gap = Number(p.gap ?? p.columnGap ?? 0)
    const cols = kids.map(k => {
      const isSpacer = typeof k !== 'string' && k.type === 'Box' && Number(k.props?.flexGrow ?? 0) > 0 && (k.children ?? []).length === 0
      return isSpacer ? ['<spacer>'] : lines(k, inner)
    })
    // a row wider than its room: the children that may shrink give up the overflow, truncated
    const boxW = (i: number) => {
      const kid = kids[i]
      return typeof kid !== 'string' && kid?.type === 'Box' && typeof kid.props?.width === 'number' ? (kid.props.width as number) : 0
    }
    const widthOf = (c: string[], i: number) => (c[0] === '<spacer>' ? 0 : Math.max(boxW(i), ...c.map(len), 0))
    let over = cols.reduce((n, c, i) => n + widthOf(c, i) + (i > 0 ? gap : 0), 0) - inner
    for (let i = 0; i < cols.length && over > 0; i++) {
      const kid = kids[i]
      if (typeof kid === 'string' || Number(kid?.props?.flexShrink ?? 0) <= 0) continue
      const w = widthOf(cols[i]!, i)
      const keep = Math.max(1, w - over)
      cols[i] = cols[i]!.map(l => cut(l, keep))
      over -= w - keep
    }
    const fixed = cols.reduce((n, c, i) => n + widthOf(c, i) + (i > 0 ? gap : 0), 0)
    const spare = Math.max(1, inner - fixed)
    const h = Math.max(1, ...cols.map(c => c.length))
    out = []
    for (let r = 0; r < h; r++) {
      out.push(
        cols
          .map((c, i) => {
            if (c[0] === '<spacer>') return ' '.repeat(spare)
            const w = Math.max(...c.map(len), 0)
            const kid = kids[i]
            const fixedW = typeof kid !== 'string' && kid?.type === 'Box' && typeof kid.props?.width === 'number' ? (kid.props.width as number) : w
            return padTo(c[r] ?? '', Math.max(w, fixedW))
          })
          .join(' '.repeat(gap))
          .replace(/\s+$/, ''),
      )
    }
  } else {
    out = kids.flatMap(k => {
      const mt = typeof k !== 'string' ? Number(k.props?.marginTop ?? 0) : 0
      return [...Array(mt).fill(''), ...lines(k, inner)]
    })
  }
  return out.map(l => (l === '' ? '' : ' '.repeat(padL) + l))
}

export function frame(tree: unknown, width: number): string {
  return lines(tree as Node, width)
    .map(l => cut(l, width))
    .join('\n')
}
