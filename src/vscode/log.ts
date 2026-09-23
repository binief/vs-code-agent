import * as vscode from 'vscode';

/** Thin wrapper over an OutputChannel, shared by the core (via HarnessHost.log). */
export class Logger {
  constructor(private readonly channel: vscode.OutputChannel, private verbose = false) {}

  setVerbose(value: boolean): void {
    this.verbose = value;
  }

  debug(message: string): void {
    if (this.verbose) this.channel.appendLine(`[debug] ${message}`);
  }

  info(message: string): void {
    this.channel.appendLine(`[info ] ${message}`);
  }

  warn(message: string): void {
    this.channel.appendLine(`[warn ] ${message}`);
  }

  error(message: string): void {
    this.channel.appendLine(`[error] ${message}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
