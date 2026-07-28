# Gemini Resolution And Aspect Ratio Public Contract

## Goal

Expose Gemini resolution tiers and aspect ratios as first-class fields in the
provider-neutral Images API while preserving existing `size` mappings and
Google `provider_options`.

## Public Fields

Synchronous JSON requests use:

```json
{
  "aspect_ratio": "16:9",
  "resolution": "4K"
}
```

Asynchronous JSON requests use:

```json
{
  "output": {
    "aspect_ratio": "16:9",
    "resolution": "4K"
  }
}
```

Synchronous and asynchronous multipart requests use the flat
`aspect_ratio` and `resolution` fields.

Accepted resolution values are `512`, `0.5K`, `1K`, `2K`, and `4K`.
`0.5K` is normalized to `512`. The Flash public model supports all five input
values. The Pro public model supports `1K`, `2K`, and `4K`.

The stable public aspect-ratio set shared by Google and We-AI Adobe Gemini is:
`1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, and `21:9`.

## Compatibility

Existing `size` values continue mapping to an aspect-ratio and resolution
tier. They are convenience aliases and do not guarantee exact Gemini output
pixels. Existing `provider_options.google.generationConfig.imageConfig`
continues to work.

Conflicts are field-specific:

- `size` conflicts with public ratio/resolution fields and any provider image
  configuration.
- `aspect_ratio` conflicts with provider `imageConfig.aspectRatio`.
- `resolution` conflicts with provider `imageConfig.imageSize`.
- Unrelated public and provider fields can be merged.

The unified API continues defaulting Gemini requests to `1:1/1K` when none of
these controls is supplied. This preserves existing cost and behavior.

## Provider Boundary

`aspect_ratio` and `resolution` are common image-output controls.
`provider_options` remains for provider-specific controls such as temperature,
thinking configuration, and safety settings. The We-AI Adobe Gemini dialect
uses the existing `generationConfig.imageConfig` upstream shape, so the worker
must not globally replace it with Google's newer `responseFormat.image` shape.

## Verification

Tests cover JSON and multipart synchronous requests, asynchronous JSON and
multipart requests, aliases, model-specific resolution rules, field-level
conflicts, fingerprints, and upstream request construction. Full static builds
are followed by local Docker dev acceptance for Gemini generation and GPT
Images regression.
