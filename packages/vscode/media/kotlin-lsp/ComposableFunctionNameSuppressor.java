package dev.elide.vscode.kotlinlsp;

import com.intellij.codeInspection.InspectionSuppressor;
import com.intellij.codeInspection.SuppressQuickFix;
import com.intellij.psi.PsiElement;
import com.intellij.psi.util.PsiTreeUtil;
import org.jetbrains.kotlin.psi.KtAnnotationEntry;
import org.jetbrains.kotlin.psi.KtNamedFunction;
import org.jetbrains.kotlin.psi.KtTypeReference;

/**
 * Composable functions are named like types (`@Composable fun Greeting()`), so Kotlin's `FunctionName`
 * inspection flags every one of them. Android Studio and IntelliJ silence it with the Compose plugin's
 * suppressor, which the Kotlin language server does not bundle; this is the same rule for the server.
 */
public final class ComposableFunctionNameSuppressor implements InspectionSuppressor {
  private static final String INSPECTION = "FunctionName";
  private static final String SHORT_NAME = "Composable";
  private static final String FQ_NAME = "androidx.compose.runtime.Composable";

  @Override
  public boolean isSuppressedFor(PsiElement element, String toolId) {
    if (!INSPECTION.equals(toolId)) return false;
    KtNamedFunction function = element instanceof KtNamedFunction named ? named : PsiTreeUtil.getParentOfType(element, KtNamedFunction.class, false);
    if (function == null) return false;
    for (KtAnnotationEntry entry : function.getAnnotationEntries()) {
      if (isComposable(entry)) return true;
    }
    return false;
  }

  private static boolean isComposable(KtAnnotationEntry entry) {
    KtTypeReference type = entry.getTypeReference();
    if (type == null) return false;
    String text = type.getText();
    return SHORT_NAME.equals(text) || FQ_NAME.equals(text);
  }

  @Override
  public SuppressQuickFix[] getSuppressActions(PsiElement element, String toolId) {
    return SuppressQuickFix.EMPTY_ARRAY;
  }
}
