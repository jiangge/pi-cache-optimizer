# Compat 配置的两个级别说明

## 问题
用户发现 compat 配置在 models.json 中有两个位置：
1. Provider 级别（渠道级别）
2. Model 级别（模型级别）

## Pi 的 Compat 合并机制

Pi 的 `model-registry.js` 支持在**两个级别**配置 compat，并会自动合并：

```typescript
// Pi 源码
result.compat = mergeCompat(provider.compat, model.compat);
```

### 1. Provider 级别
```json
{
  "providers": {
    "deepseek": {
      "compat": {
        "thinkingFormat": "deepseek",
        "requiresReasoningContentOnAssistantMessages": true
      },
      "models": [...]
    }
  }
}
```

- **位置**: `providers["provider-name"].compat`
- **作用域**: 该 provider 下的**所有模型**
- **适用**: 同一渠道的多个模型共享相同配置

### 2. Model 级别
```json
{
  "providers": {
    "provider-name": {
      "models": [
        {
          "id": "model-id",
          "compat": {
            "forceAdaptiveThinking": true
          }
        }
      ]
    }
  }
}
```

- **位置**: `providers["provider-name"].models[].compat`
- **作用域**: **单个模型**
- **优先级**: **高于** provider 级别（会覆盖同名 key）

### 合并规则

```
最终 compat = merge(provider.compat, model.compat)
```

Model 级别的 compat 会覆盖 provider 级别的同名 key。

## 用户实际使用情况

从 `~/.pi/agent/models.json` 可以看到用户在 **provider 级别** 配置了 compat：

```json
{
  "providers": {
    "deepseek": {
      "compat": {
        "requiresReasoningContentOnAssistantMessages": true,
        "thinkingFormat": "deepseek",
        "supportsLongCacheRetention": true,
        "sendSessionAffinityHeaders": true
      },
      "models": [
        { "id": "deepseek-v4-pro" },
        { "id": "deepseek-v4-flash" }
      ]
    }
  }
}
```

这样两个模型都会继承这些 compat 设置。

## 我们的实现

### Doctor/Compat 诊断

✅ **已支持两级建议**

`appendCredentialSafeProviderGuidance` 函数会同时提供两种建议：

1. **Provider-level minimal override** — 渠道级别，影响所有模型
2. **Single-model override** — 模型级别，只影响当前模型

用户可以根据需要选择使用哪一个。

### Fix 子命令

⚠️ **当前只支持 model 级别**

原因：
- **更安全**: 只影响当前模型，不会意外影响同渠道的其他模型
- **更明确**: 用户明确知道修改范围
- **符合原始需求**: PRD 中要求"仅当前 active model"

用户如果需要修改 provider 级别，可以：
1. 查看 `/cache-optimizer doctor` 或 `/cache-optimizer compat` 的建议
2. 复制 "Provider-level minimal override" 的 JSON
3. 手动编辑 `~/.pi/agent/models.json`

### GetCompat 函数

✅ **Pi 已自动合并**

```typescript
function getCompat(model: PiModel | undefined): CacheCompat {
  if (!model) return {} as CacheCompat;
  
  // Pi 的 ctx.model 已经包含合并后的 compat
  // (provider.compat + model.compat)
  const modelCompat = (model.compat ?? {}) as CacheCompat;
  return modelCompat;
}
```

Pi 在传递 `ctx.model` 给扩展时，已经合并了 provider 和 model 两级的 compat，所以我们直接读取 `model.compat` 即可获得最终的有效配置。

## 建议

### 用户应该选择哪个级别？

**Provider 级别** (推荐):
- ✅ 同一渠道的多个模型共享配置
- ✅ 配置更简洁，不需要每个模型都写一遍
- ✅ 维护更方便
- ⚠️ 需要手动编辑（fix 不支持）

**Model 级别**:
- ✅ 只影响单个模型
- ✅ 可以用 `/cache-optimizer fix` 自动修复
- ✅ 可以覆盖 provider 级别的配置
- ⚠️ 多个模型需要重复配置

### 实际使用建议

1. **新渠道/多个模型共享**: 手动在 provider 级别配置
2. **单个模型特殊配置**: 使用 `/cache-optimizer fix` 或手动在 model 级别配置
3. **临时覆盖**: 在 model 级别添加，覆盖 provider 的配置

## 状态

✅ **getCompat**: 正确处理（Pi 已合并）
✅ **Doctor/Compat**: 提供两级建议
⚠️ **Fix**: 只支持 model 级别（设计决策，保持不变）

**结论**: 当前实现是正确的，文档需要明确说明两级配置的使用场景。
