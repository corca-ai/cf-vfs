export class ShellEnvironment extends Map<string, string> {
  private optindGenerationValue: number;

  constructor(
    entries: Iterable<readonly [string, string]> = [],
    optindGeneration = 0,
  ) {
    super();
    for (const [name, value] of entries) super.set(name, value);
    this.optindGenerationValue = optindGeneration;
  }

  get optindGeneration(): number {
    return this.optindGenerationValue;
  }

  override set(name: string, value: string): this {
    if (name === "OPTIND") this.optindGenerationValue += 1;
    return super.set(name, value);
  }

  override delete(name: string): boolean {
    if (name === "OPTIND") this.optindGenerationValue += 1;
    return super.delete(name);
  }

  override clear(): void {
    if (this.has("OPTIND")) this.optindGenerationValue += 1;
    super.clear();
  }

  clone(): ShellEnvironment {
    return new ShellEnvironment(this, this.optindGenerationValue);
  }

  setFromGetopts(value: string): void {
    super.set("OPTIND", value);
  }
}

export function optindGeneration(environment: Map<string, string>): number {
  return environment instanceof ShellEnvironment ? environment.optindGeneration : 0;
}

export function setOptindFromGetopts(environment: Map<string, string>, value: string): void {
  if (environment instanceof ShellEnvironment) environment.setFromGetopts(value);
  else environment.set("OPTIND", value);
}
