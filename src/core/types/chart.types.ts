/** One labelled figure a chart draws: a bar, or a point on a line. */
export interface ChartDatum {
  label: string;
  value: number;
}

export interface ChartOptions {
  /** Names the chart: the SVG's `<title>` and the head of its figure line. */
  title: string;
  /** How a value prints, on the chart and in its figure line; plain numbers by default. */
  format?: (value: number) => string;
}

/** One capture on a time axis; a `value` left undefined is a capture that did not measure it. */
export interface TimeDatum {
  /** Milliseconds since the epoch. */
  at: number;
  label: string;
  value: number | undefined;
  /** Not comparable with the value before it (counted under another rule): the line breaks here too. */
  breakBefore?: boolean;
}

/** Something that happened at a moment, marked across the plot: a merge. */
export interface TimeMarker {
  at: number;
  /** Its hover, naming it. */
  label: string;
  /** Where it links to, when it does; the caller vouches for the url's shape. */
  href?: string;
}
