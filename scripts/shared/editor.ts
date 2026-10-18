import openEditor from 'open-editor';

export async function openInEditor(absPath: string): Promise<boolean> {
  try {
    await openEditor([absPath], { wait: true });
    return true;
  } catch {
    return false;
  }
}
