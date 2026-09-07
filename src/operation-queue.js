// Serialize complete MCP operations; legacy sessions can share a browser tab.
export class OperationQueue {
  #tail = Promise.resolve();
  run(fn) {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => {});
    return result;
  }
}
