/** Small identity chip for a client's New/Existing type or its category (Corporate, Agency, ...). */
export default function ClientTypeBadge({ clientType, clientCategory }) {
  const text = clientType || clientCategory;
  if (!text) return <span className="text-[10px] text-ink-soft/50">—</span>;
  return (
    <span className="inline-block rounded-full bg-ink/8 px-2 py-0.5 text-[10px] font-medium text-ink-soft">
      {text}
    </span>
  );
}
