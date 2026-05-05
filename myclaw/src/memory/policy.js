export const MEMORY_PERMISSIONS = {
  READ: 'memory.read',
  WRITE: 'memory.write',
  PROCEDURAL_WRITE: 'memory.procedural.write',
  DELETE: 'memory.delete',
  REINDEX: 'memory.reindex',
  POLICY_CHANGE: 'policy.change',
  SKILL_WRITE: 'skill.write',
  APPROVAL_MEMORY_WRITE: 'approval.memory.write',
  APPROVAL_ADMIN: 'approval.admin',
};

export class MemoryPolicyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MemoryPolicyError';
    this.details = details;
  }
}

export class MemoryPolicyGate {
  constructor({ toolPolicy = null } = {}) {
    this.toolPolicy = toolPolicy;
  }

  canRead(layer, context = {}) {
    if (['working', 'session'].includes(layer)) return true;
    return this._hasAny(context, [MEMORY_PERMISSIONS.READ]);
  }

  enforceRead(layer, context = {}) {
    if (!this.canRead(layer, context)) {
      throw new MemoryPolicyError(`${layer} memory read requires ${MEMORY_PERMISSIONS.READ}`, { layer });
    }
  }

  enforceWrite(record, context = {}) {
    if (['working', 'session'].includes(record.layer)) return;
    if (record.layer === 'semantic') {
      this._requireAny(context, [
        MEMORY_PERMISSIONS.WRITE,
        MEMORY_PERMISSIONS.APPROVAL_MEMORY_WRITE,
        MEMORY_PERMISSIONS.POLICY_CHANGE,
        MEMORY_PERMISSIONS.APPROVAL_ADMIN,
      ], record.layer);
      return;
    }
    if (record.layer === 'procedural') {
      this._requireAny(context, [
        MEMORY_PERMISSIONS.PROCEDURAL_WRITE,
        MEMORY_PERMISSIONS.POLICY_CHANGE,
        MEMORY_PERMISSIONS.SKILL_WRITE,
      ], record.layer);
      return;
    }
    throw new MemoryPolicyError(`Unknown memory layer: ${record.layer}`);
  }

  enforceDelete(record, context = {}) {
    this._requireAny(context, [MEMORY_PERMISSIONS.DELETE], record?.layer || 'memory');
  }

  enforceReindex(layer, context = {}) {
    if (['working', 'session'].includes(layer)) return;
    this._requireAny(context, [MEMORY_PERMISSIONS.REINDEX], layer);
  }

  _requireAny(context, permissions, layer) {
    if (!this._hasAny(context, permissions)) {
      throw new MemoryPolicyError(`${layer} memory operation requires one of: ${permissions.join(', ')}`, {
        layer,
        permissions,
      });
    }
  }

  _hasAny(context, permissions) {
    const granted = new Set(context.permissions || []);
    for (const permission of permissions) {
      if (granted.has(permission)) return true;
      if (this.toolPolicy?.isAllowed?.(permission)) return true;
    }
    return false;
  }
}
