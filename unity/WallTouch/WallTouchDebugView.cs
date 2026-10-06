using UnityEngine;

/// <summary>Optional IMGUI overlay; marker coordinates use the current game view.</summary>
public sealed class WallTouchDebugView : MonoBehaviour
{
    public WallTouchReceiver receiver;
    public KeyCode toggleKey = KeyCode.F1;
    public bool visible = true;
    public Color markerColor = Color.cyan;
    [Min(2)] public float markerSize = 18;

    private void OnEnable()
    {
        if (receiver == null) receiver = GetComponent<WallTouchReceiver>();
    }

    private void OnGUI()
    {
        // IMGUI key events work without a dependency on either input package.
        Event keyEvent = Event.current;
        if (keyEvent != null && keyEvent.type == EventType.KeyDown && keyEvent.keyCode == toggleKey)
        {
            visible = !visible;
            keyEvent.Use();
        }
        if (!visible || receiver == null) return;
        GUI.Box(new Rect(10, 10, 490, 70), GUIContent.none);
        GUI.Label(new Rect(20, 16, 470, 24), "Wall touch: " + (receiver.Connected ? "Connected" : "Disconnected")
            + " | " + (receiver.Ready ? "Ready" : "Not ready") + " | Session " + receiver.Session);
        GUI.Label(new Rect(20, 42, 470, 24), "Touches " + receiver.Touches.Count + " | "
            + receiver.PacketsPerSecond.ToString("F1") + " packets/s | " + toggleKey + " to toggle");
        if (!string.IsNullOrEmpty(receiver.LastError))
            GUI.Label(new Rect(20, 84, Screen.width - 40, 24), receiver.LastError);
        Color previous = GUI.color;
        foreach (WallTouch touch in receiver.Touches.Values)
        {
            Vector2 pixel = receiver.ToScreen(touch);
            float guiY = Screen.height - pixel.y; // IMGUI origin is top-left.
            GUI.color = markerColor;
            GUI.DrawTexture(new Rect(pixel.x - markerSize / 2, guiY - markerSize / 2, markerSize, markerSize), Texture2D.whiteTexture);
            GUI.color = Color.white;
            GUI.Label(new Rect(Mathf.Clamp(pixel.x + markerSize, 0, Mathf.Max(0, Screen.width - 260)),
                Mathf.Clamp(guiY - 12, 0, Mathf.Max(0, Screen.height - 24)), 260, 24),
                "#" + touch.Id + "  " + (string.IsNullOrEmpty(touch.Zone) ? "(whole wall)" : touch.Zone));
        }
        GUI.color = previous;
    }
}
