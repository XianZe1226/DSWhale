'use strict';
const { runBounded } = require('./runtime.cjs');

class ExtensionRunner {
  constructor(manager, runner = runBounded) { this.manager = manager; this.runner = runner; this.closed = false; this.operation = null; }
  async run(action, id) {
    if (this.closed) throw new Error('应用正在退出');
    if (!['status', 'check', 'update', 'rollback'].includes(action)) throw new Error('插件操作无效');
    if (action !== 'status' && !['memory', 'memes'].includes(id)) throw new Error('插件无效');
    if (this.operation) throw new Error('插件操作尚未完成');
    const controller = new AbortController(); this.controller = controller;
    const operation = (async () => {
      const env = await this.manager.environment();
      if (this.closed || controller.signal.aborted) throw new Error('应用正在退出，插件操作已取消');
      const args = ['-m', 'dswhale.extensions', '--host', this.manager.host, action];
      if (action !== 'status') args.push('--id', id);
      const raw = await this.runner(this.manager.python, args, { env, cwd: this.manager.host, signal: controller.signal, timeout: 1020000, maxBytes: 65536, allowNonzero: true });
      if (controller.signal.aborted) throw new Error('插件操作已取消');
      let value;
      try { value = JSON.parse(raw.toString('utf8')); }
      catch { throw new Error('插件操作未完成，请重试或检查网络'); }
      if (value.ok === false || value.error) throw new Error(typeof value.error === 'string' && value.error.length <= 300 ? value.error : '插件操作未完成');
      if (!value.memory || !value.memes) throw new Error('插件状态不完整，请重新检查');
      return value;
    })();
    this.operation = operation;
    try { return await operation; }
    finally { this.operation = null; this.controller = null; }
  }
  async close() { this.closed = true; this.controller?.abort(); await this.operation?.catch(() => {}); }
}
async function runExtensionAction(host, action, id) {
  if (!['update', 'rollback'].includes(action)) return host.runner.run(action, id);
  host.closePanel(); await host.supervisor.stop();
  if (host.isClosing()) throw new Error('应用正在退出');
  host.publish({ phase: 'installing', step: `${action === 'update' ? '备份并更新' : '回退'}${id === 'memory' ? 'LivingMemory' : '表情包管理器'}`, progress: null, error: undefined });
  try { return await host.runner.run(action, id); }
  finally { if (!host.isClosing()) await host.refresh(); }
}
module.exports = { ExtensionRunner, runExtensionAction };
