/** Shared preflight and run sequence for the image-generation tool. */
export async function runImageGeneration(ops, {
  prompt,
  newSession,
  model = 'argon',
  thinkingLevel = 'high',
  referenceImages = [],
  fullSize,
  timeout,
  onUpload = () => {},
}) {
  if (newSession) {
    const newChat = await ops.click('newChatBtn');
    if (!newChat?.ok) return { ok: false, stage: 'new_chat', error: newChat?.error || 'new chat failed' };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const modelResult = await ops.switchToModel(model);
  if (!modelResult?.ok) {
    return { ok: false, stage: 'model', error: modelResult?.error || `${model} model unavailable` };
  }

  const thinkingResult = await ops.setThinkingDepth(thinkingLevel);
  if (!thinkingResult?.ok) {
    return { ok: false, stage: 'thinking', error: thinkingResult?.error || `${thinkingLevel} thinking level unavailable` };
  }

  for (const imagePath of referenceImages) {
    onUpload(imagePath);
    const result = await ops.uploadImage(imagePath);
    if (!result?.ok) {
      return { ok: false, stage: 'upload', path: imagePath, error: result?.error || 'upload failed' };
    }
  }

  if (referenceImages.length > 0) onUpload(null, referenceImages.length);
  const result = await ops.generateImage(prompt, { fullSize, timeout });
  return { ok: true, result };
}
