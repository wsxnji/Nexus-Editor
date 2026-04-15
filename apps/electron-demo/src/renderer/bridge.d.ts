interface DemoFileHandle {
  path: string;
  content: string;
}

interface DemoBridge {
  openFile(): Promise<DemoFileHandle | null>;
  saveFile(path: string, content: string): Promise<{ path: string }>;
  saveFileAs(content: string): Promise<{ path: string } | null>;
}

interface Window {
  nexusDemo: DemoBridge;
}
