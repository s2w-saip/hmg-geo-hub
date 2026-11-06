// Type-only snapshot; no database or server implementation is included.
/** null = 값 없음(예: 분모 0 이라 비율이 없는 행) — 방향과 무관하게 항상 맨 뒤. */
export type Sorter<T> = (row: T) => string | number | null;
export type UseSortableTableOptions<K extends string> = {
    defaultKey: K;
    /** true = ascending on first paint. false = descending (most common for numeric leaderboards). */
    defaultAsc?: boolean;
    /** Sort keys that default to ascending direction when first selected.
     *  Common case: string columns flip to ascending; numeric flip to descending. */
    ascByDefault?: K[];
};
export type SortableHeaderProps<K extends string> = {
    active: boolean;
    asc: boolean;
    onClick: () => void;
    sortKey: K;
};
export declare function useSortableTable<T, K extends string>(rows: T[], sorters: Record<K, Sorter<T>>, opts: UseSortableTableOptions<K>): {
    sorted: T[];
    sortKey: K;
    asc: boolean;
    toggleSort: (next: K) => void;
    headerProps: (key: K) => SortableHeaderProps<K>;
};
