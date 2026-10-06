#if WALL_TOUCH_RECEIVER_TEST
// Compile-time surface only; these checks do not emulate Unity rendering.
using System;

namespace UnityEngine
{
    public class MonoBehaviour { public T GetComponent<T>() where T : class { return null; } }
    public sealed class DisallowMultipleComponent : Attribute { }
    public sealed class HeaderAttribute : Attribute { public HeaderAttribute(string text) { } }
    public sealed class RangeAttribute : Attribute { public RangeAttribute(float min, float max) { } }
    public sealed class MinAttribute : Attribute { public MinAttribute(float min) { } }
    public struct Vector2
    {
        public float x, y;
        public Vector2(float x, float y) { this.x = x; this.y = y; }
    }
    public struct Vector3
    {
        public float x, y, z;
        public Vector3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; }
    }
    public struct Ray { public Vector3 origin, direction; }
    public class Camera
    {
        public Vector3 LastViewport;
        public Vector3 ViewportToWorldPoint(Vector3 value) { LastViewport = value; return value; }
        public Ray ViewportPointToRay(Vector3 value) { LastViewport = value; return new Ray { origin = value }; }
    }
    public static class Screen { public static int width = 1920, height = 1080; }
    public struct Color
    {
        public static Color cyan { get { return new Color(); } }
        public static Color white { get { return new Color(); } }
    }
    public struct Rect { public Rect(float x, float y, float width, float height) { } }
    public enum KeyCode { F1, F2 }
    public enum EventType { KeyDown, Repaint, Used }
    public sealed class Event
    {
        public static Event current;
        public EventType type;
        public KeyCode keyCode;
        public void Use() { type = EventType.Used; }
    }
    public sealed class GUIContent { public static readonly GUIContent none = new GUIContent(); }
    public sealed class Texture2D { public static readonly Texture2D whiteTexture = new Texture2D(); }
    public static class GUI
    {
        public static Color color;
        public static int Markers;
        public static void Box(Rect rect, GUIContent content) { }
        public static void Label(Rect rect, string text) { }
        public static void DrawTexture(Rect rect, Texture2D texture) { Markers++; }
    }
    public static class Mathf
    {
        public static float Clamp(float value, float min, float max) { return Math.Max(min, Math.Min(max, value)); }
        public static float Max(float a, float b) { return Math.Max(a, b); }
    }
    public static class Debug { public static void LogError(string message, object context) { Console.WriteLine(message); } }
}

namespace UnityEngine.Events
{
    public class UnityEvent<T>
    {
        private event Action<T> Listeners;
        public void AddListener(Action<T> listener) { Listeners += listener; }
        public void Invoke(T value) { if (Listeners != null) Listeners(value); }
    }
}
#endif
