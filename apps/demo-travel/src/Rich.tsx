/** Shows the model's **bold** markers as bold. Everything else stays plain text: no HTML is rendered. */
export function Rich({ text }: { text: string }) {
  return <p>{text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))}</p>
}
