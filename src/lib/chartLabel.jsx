// The one place that decides how a value label sits on a bar/point, so every
// chart in the dashboard shares the same font, size, and positioning logic
// instead of each one reinventing it. Pass the result to a recharts `<Bar
// label={...} />` directly — Bar renders its `label` prop as-is. `<Line>`/
// `<Area>` don't: their bare `label` prop is silently dropped in this
// Recharts version, so pointLabel's result must go through
// `<LabelList dataKey="..." content={pointLabel(...)} />` as an explicit
// child instead — that's the one code path Recharts actually renders for
// per-point labels on those chart types.

const LABEL_STYLE = { fontSize: 10, fontFamily: 'Inter, sans-serif', fontWeight: 600, fill: '#1e1e2c' };

/** For vertical bars (categories on the x-axis): label centered above the bar. */
export function verticalBarLabel(formatter = (v) => v) {
  return function VerticalBarLabel(props) {
    const { x, y, width, value } = props;
    if (value == null) return null;
    return (
      <text x={x + width / 2} y={y - 6} textAnchor="middle" style={LABEL_STYLE}>
        {formatter(value)}
      </text>
    );
  };
}

/** For horizontal bars (categories on the y-axis): label to the right of the bar. */
export function horizontalBarLabel(formatter = (v) => v) {
  return function HorizontalBarLabel(props) {
    const { x, y, width, height, value } = props;
    if (value == null) return null;
    return (
      <text x={x + width + 6} y={y + height / 2 + 3.5} textAnchor="start" style={LABEL_STYLE}>
        {formatter(value)}
      </text>
    );
  };
}

/** For line/area charts: label above each point. */
export function pointLabel(formatter = (v) => v) {
  return function PointLabel(props) {
    const { x, y, value } = props;
    if (value == null) return null;
    return (
      <text x={x} y={y - 8} textAnchor="middle" style={LABEL_STYLE}>
        {formatter(value)}
      </text>
    );
  };
}

export const AXIS_TICK_STYLE = { fontSize: 10, fontFamily: 'Inter, sans-serif', fill: '#5a5a6e' };
