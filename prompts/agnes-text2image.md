# 二转 Agnes · 宣传图提示词

> 用途：给你二转后的 Agnes 做宣传物料。
> 模型：`agnes-image-2.5-flash`（OpenAI 兼容，`POST /v1/images/generations`）
> **注意：Agnes 的 Authorization 不带 `Bearer` 前缀**，裸 token 才行。
> 三条均已实测出图成功（1024×1024 PNG）。

## 用法要点（先看这三条，能省很多废图）

1. **别让 AI 写文字。** 让它留白，标题/logo 后期叠上去。AI 渲染的文字基本都是乱码，而且改一次要重出一张。
2. **明确要求留白位置**（`empty dark space in the right third for headline text`），否则模型会把主体放正中间，你没地方放标题。
3. **尺寸**：本文按 1024×1024 出。要横版头图就用 `size` 换比例（若支持），或在后期裁切；主体偏左/偏右构图更耐裁。

---

## 1. 主视觉（推荐首选）

**思路**：一个入口 → 分成多路上游。直接对应你的核心卖点「二转聚合、多路调度」。

```
Ultra-wide cinematic hero banner, 16:9. On the left, a single glowing gateway node emits a clean
beam of light that splits into five parallel streams flowing rightward, each ending at a different
geometric node. Dark navy-to-black gradient background, cyan and soft violet glow, subtle grid
lines, volumetric light, sharp focus, minimal high-end tech aesthetic, generous empty dark space
in the right third for headline text, no text, no logos, no watermark, 8k, professional brand key
visual.
```

## 2. 对比型（讲价值）

**思路**：左边一条线断掉，右边五条线编在一起稳定发光。一眼看懂「单路会挂，多路才稳」。

```
Square minimal infographic-style illustration on a dark charcoal background. Left half: one thin
fragile line snapping in the middle with a small warning spark. Right half: five thick confident
lines braided together, glowing steadily. Flat vector aesthetic, cyan and soft amber accents,
clean geometry, equal visual weight, subtle gradient, modern SaaS brand illustration, no text,
no numbers, no logos, high contrast.
```

## 3. 技术质感（低调专业）

**思路**：不画概念，画质感。适合放在落地页背景、文档首页，不抢文字。

```
Photorealistic macro photograph through a bundle of optical fibers carrying bright cyan light
pulses, the bundle running diagonally across the frame. Extremely shallow depth of field, f/1.4,
bokeh circles in the background, dark environment, high contrast, crisp glass detail, cold color
grade with one warm accent light. Corporate technology advertising photography, no text, no
logos, 8k.
```

## 4. 备选：稳定/可靠（若你想主打"不挂"）

```
Minimal dark poster: a single continuous unbroken line drawing a perfect circle, rendered as a
glowing cyan fiber-optic filament on near-black. Perfectly centered geometric composition,
generous negative space above and below, subtle floor reflection, precision engineering mood,
ultra clean, no text, no logos, 8k.
```

## 5. 备选：速度/低延迟

```
Dynamic long-exposure light trails converging into one point of stillness in the center, on a
pure black background. Cool white and cyan streaks with slight motion blur, the center point
razor sharp. Sense of speed resolving into calm, abstract, high-end, no text, no logos, 8k.
```

---

## 负面提示词

若模型支持 negative prompt：

```
text, watermark, signature, logo, letters, numbers, garbled text, deformed hands, extra fingers,
blurry, low contrast, jpeg artifacts, cluttered composition, oversaturated
```

## 调用（直连 Agnes）

```bash
curl -s https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: sk-你的key" \
  -H 'content-type: application/json' \
  -d '{"model":"agnes-image-2.5-flash","prompt":"<上面任一条>","n":1,"size":"1024x1024"}'
```

返回 `data[0].url` 是图片地址（不是 base64）。

## 一个缺口

`api-relay` 目前只有 `chat/completions`、`embeddings`、`completions`，**没有 `/v1/images/generations`**。
所以出图只能直连 Agnes，拿不到中转站那层的 key 池轮换、归因、额度计数与成本记账。
要的话可以补上——图片端点是纯转发，能复用现成的鉴权格式与度量。
