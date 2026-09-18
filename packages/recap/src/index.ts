export interface RecapLifecycleService {
  active(): boolean;
}

export interface RecapEngineService {
  activate(): void;
  stop(): void;
}
