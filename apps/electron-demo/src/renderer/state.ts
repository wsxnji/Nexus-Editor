export interface AppState {
  filePath: string | null;
  content: string;
  dirty: boolean;
  error: string | null;
}

export function createState(): AppState {
  return {
    filePath: null,
    content: "",
    dirty: false,
    error: null,
  };
}
