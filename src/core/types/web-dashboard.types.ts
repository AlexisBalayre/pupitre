/** What a marked list of the web dashboard shows: the rows matched, its page of them, and how many pages there are. */
export interface ListWindow {
  shown: number[];
  matched: number;
  page: number;
  pages: number;
}
