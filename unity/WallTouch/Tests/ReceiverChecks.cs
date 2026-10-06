#if WALL_TOUCH_RECEIVER_TEST
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using UnityEngine;

internal static class ReceiverChecks
{
    private static int _assertions;
    private const BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;

    public static int Main()
    {
        try
        {
            CheckParser();
            CheckRetiredSessions();
            CheckAliveBoundary();
            CheckFilterListenerShutdown();
            CheckLifecycle();
            CheckTimeoutAndShutdown();
            CheckFilterAndHelpers();
            CheckListenerShutdown();
            CheckCustomPrefix();
            CheckBindError();
            Console.WriteLine("PASS: " + _assertions + " assertions; parser, loopback UDP, lifecycle, timeout, shutdown, helpers, filter and overlay.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private static void Assert(bool value, string message)
    {
        _assertions++;
        if (!value) throw new Exception(message);
    }
    private static void Near(float value, float expected, string message) { Assert(Math.Abs(value - expected) < 0.001f, message); }
    private static void Call(object component, string method) { component.GetType().GetMethod(method, Private).Invoke(component, null); }
    private static object Field(object component, string name) { return component.GetType().GetField(name, Private).GetValue(component); }

    private static void CheckParser()
    {
        IList parsed;
        byte[] values = Message("/test", "ifs", int.MinValue, 0.125f, "영역_2");
        Assert(Parse(values, out parsed) && parsed.Count == 1, "standalone message");
        object[] args = (object[])parsed[0].GetType().GetField("Args").GetValue(parsed[0]);
        Assert((int)args[0] == int.MinValue && (string)args[2] == "영역_2", "big-endian int and UTF-8 string");
        Near((float)args[1], 0.125f, "big-endian float");
        byte[] skipped = Message("/ignored", "hdtTFNbifs", 42L, 12.5, 1L, null, null, null,
            new byte[] { 1, 2, 3 }, int.MaxValue, -0.5f, "ok");
        Assert(Parse(Bundle(skipped, Bundle(values)), out parsed) && parsed.Count == 2, "nested bundles and skipped tags");
        args = (object[])parsed[0].GetType().GetField("Args").GetValue(parsed[0]);
        Assert((int)args[7] == int.MaxValue && (string)args[9] == "ok", "skipped types preserve argument offsets");
        byte[] valid = Bundle(values);
        for (int length = 0; length < valid.Length; length++)
        {
            // The 16-byte prefix is a valid empty bundle; all other prefixes fail.
            byte[] truncated = new byte[length];
            Array.Copy(valid, truncated, length);
            bool ok = Parse(truncated, out parsed);
            Assert(length == 16 ? ok && parsed.Count == 0 : !ok, "truncated packet " + length);
        }
        byte[] hugeElement = (byte[])valid.Clone();
        Array.Copy(IntBytes(int.MaxValue), 0, hugeElement, 16, 4);
        Assert(!Parse(hugeElement, out parsed), "oversized bundle element");
        byte[] blob = Message("/b", "b", new byte[] { 1, 2, 3 });
        Array.Copy(IntBytes(int.MaxValue), 0, blob, 8, 4);
        Assert(!Parse(blob, out parsed), "oversized blob");
        Array.Copy(IntBytes(-1), 0, blob, 8, 4);
        Assert(!Parse(blob, out parsed), "negative blob size");
        byte[] invalidUtf8 = Message("/s", "s", "a");
        invalidUtf8[8] = 255;
        Assert(!Parse(invalidUtf8, out parsed), "invalid UTF-8");
        byte[] badPadding = Message("/s", "s", "a");
        badPadding[11] = 1;
        Assert(!Parse(badPadding, out parsed), "invalid padding");
        byte[] unknown = Message("/test", "i", 1);
        unknown[9] = (byte)'x'; // Type tag after /test\0 padding and comma.
        Assert(!Parse(Bundle(values, unknown), out parsed), "unknown tags reject the entire packet");
        byte[] deep = values;
        for (int i = 0; i < 34; i++) deep = Bundle(deep);
        Assert(!Parse(deep, out parsed), "bounded nesting");
        var random = new Random(7109);
        for (int i = 0; i < 5000; i++)
        {
            byte[] malformed = new byte[random.Next(0, 256)];
            random.NextBytes(malformed);
            Parse(malformed, out parsed); // Any exception fails Main.
        }
        Console.WriteLine("Parser: truncation, lengths, UTF-8, tags, nesting and 5000 malformed packets checked.");
    }

    private static bool Parse(byte[] packet, out IList output, double at = 1.0)
    {
        Type messageType = typeof(WallTouchReceiver).GetNestedType("OscMessage", BindingFlags.NonPublic);
        output = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(messageType));
        Type parser = typeof(WallTouchReceiver).GetNestedType("OscParser", BindingFlags.NonPublic);
        return (bool)parser.GetMethod("TryParse", BindingFlags.Public | BindingFlags.Static).Invoke(null, new object[] { packet, at, output });
    }

    // Original osc.js bytes from the reviewers' rtests repros, retained here so
    // these regressions run without the reviewers' machine-specific scratch path.
    private const string Session101Packet = "I2J1bmRsZQAAAAAAAAAAAQAAACgvd2FsbC90b3VjaAAsaWlmZnMAAAAAAAEAAAAAPkzMzT8zMzNvbGQAAAAAMC93YWxsL3pvbmUvb2xkL3RvdWNoAAAAACxpaWZmAAAAAAAAAQAAAAA+zMzNPszMzQAAACQvd2FsbC9mcmFtZQAsaWlpaQAAAAAAAGUAAAABAAAAAQAAAAEAAAAUL3dhbGwvYWxpdmUALGkAAAAAAAE=";
    private const string Session202Packet = "I2J1bmRsZQAAAAAAAAAAAQAAACgvd2FsbC90b3VjaAAsaWlmZnMAAAAAAAEAAAAAPkzMzT8zMzNuZXcAAAAAMC93YWxsL3pvbmUvbmV3L3RvdWNoAAAAACxpaWZmAAAAAAAAAQAAAAA+zMzNPszMzQAAACQvd2FsbC9mcmFtZQAsaWlpaQAAAAAAAMoAAAACAAAAAQAAAAEAAAAUL3dhbGwvYWxpdmUALGkAAAAAAAE=";
    private const string Delayed101Packet = "I2J1bmRsZQAAAAAAAAAAAQAAACgvd2FsbC90b3VjaAAsaWlmZnMAAAAAAAEAAAABPkzMzT8zMzNvbGQAAAAAMC93YWxsL3pvbmUvb2xkL3RvdWNoAAAAACxpaWZmAAAAAAAAAQAAAAE+zMzNPszMzQAAACQvd2FsbC9mcmFtZQAsaWlpaQAAAAAAAGUAAAACAAAAAQAAAAEAAAAUL3dhbGwvYWxpdmUALGkAAAAAAAE=";
    private const string FilterMovePacket = "I2J1bmRsZQAAAAAAAAAAAQAAACgvd2FsbC90b3VjaAAsaWlmZnMAAAAAAAEAAAABPkzMzT6ZmZpuZXcAAAAAJC93YWxsL2ZyYW1lACxpaWlpAAAAAAAAZQAAAAMAAAABAAAAAQAAABQvd2FsbC9hbGl2ZQAsaQAAAAAAAQ==";

    private static void CheckRetiredSessions()
    {
        using (var f = new Fixture())
        {
            f.Deliver(Convert.FromBase64String(Session101Packet));
            f.Deliver(Convert.FromBase64String(Session202Packet));
            WallTouch current = f.Receiver.Touches[1];
            Assert(f.Receiver.Session == 202 && current.Zone == "new" && current.HasLocalPosition,
                "real osc.js reconnect frame accepted");
            int callbacks = f.Order.Count;
            double frameAt = (double)Field(f.Receiver, "_lastFrameAt");
            f.Deliver(Convert.FromBase64String(Delayed101Packet));
            Assert(f.Receiver.Session == 202 && ReferenceEquals(current, f.Receiver.Touches[1]) && f.Order.Count == callbacks,
                "retired session replay cannot replace new touches or emit callbacks");
            Assert((int)Field(f.Receiver, "_sequence") == 2 && (double)Field(f.Receiver, "_lastFrameAt") == frameAt,
                "retired session cannot change sequence or extend the frame timeout");
            f.Deliver(Bundle(Touch(1, 3, 0.9f, 0.1f, "old"), Frame(101, 3, 0, 0), Alive()));
            Assert(f.Receiver.Ready && f.Receiver.Touches.ContainsKey(1) && f.Order.Count == callbacks,
                "retired cancel, ready=0 and empty alive are ignored together");
            // Attribute a separate pending touch/local bundle to its completing frame.
            f.Deliver(Bundle(Touch(99, 0, 0.9f, 0.1f, "old"), Local(99, 0, 0.8f, 0.2f, "old")));
            f.Deliver(Bundle(Frame(101, 4, 1, 1), Alive(99)));
            f.Deliver(Bundle(Frame(202, 3, 1, 1), Alive(1)));
            Assert(f.Order.Count == callbacks && !f.Receiver.Touches.ContainsKey(99) && current.Zone == "new",
                "retired pending touches and local coordinates cannot leak into the next frame");
            f.Deliver(Bundle(Touch(1, 1, 0.3f, 0.7f, "new"), Frame(202, 4, 1, 1), Alive(1)));
            Assert(f.Moved.Count == 1, "current session still delivers moves after old packets");
            f.Deliver(Bundle(Touch(1, 0, 0.4f, 0.6f, "latest"), Frame(303, 1, 1, 1), Alive(1)));
            callbacks = f.Order.Count;
            f.Deliver(Convert.FromBase64String(Session202Packet));
            Assert(f.Receiver.Session == 303 && f.Receiver.Touches[1].Zone == "latest" && f.Order.Count == callbacks,
                "multiple retired sessions are remembered");
        }
        using (var f = new Fixture())
        {
            for (int session = 1000; session <= 1017; session++)
                f.Deliver(Bundle(Frame(session, 1, 0, 1), Alive()));
            Assert(((ICollection<int>)Field(f.Receiver, "_retiredSessions")).Count == 16,
                "retired session history has bounded memory");
            f.Deliver(Bundle(Frame(1001, 2, 0, 0), Alive()));
            Assert(f.Receiver.Session == 1017 && f.Receiver.Ready, "oldest retained session is rejected");
        }
    }

    private static void CheckAliveBoundary()
    {
        using (var f = new Fixture())
        {
            // ReviewChecks.cs repro: the final bundle overtakes the touch bundle.
            f.Deliver(Bundle(Frame(303, 1, 0, 1), Alive()));
            f.Deliver(Bundle(Touch(7, 0, 0.25f, 0.75f, "area"), Local(7, 0, 0.5f, 0.5f, "area")));
            f.Deliver(Bundle(Frame(303, 2, 0, 1), Alive()));
            Assert(f.Order.Count == 0 && f.Receiver.Touches.Count == 0,
                "late begin absent from the next alive snapshot never emits begin/end");
            f.Deliver(Bundle(Touch(8, 0, 0.25f, 0.75f, ""), Frame(303, 3, 1, 1), Alive(8)));
            f.Deliver(Bundle(Touch(8, 1, 0.9f, 0.1f, ""), Touch(9, 1, 0.5f, 0.5f, ""), Frame(303, 4, 0, 1), Alive()));
            Assert(f.Began.Count == 1 && f.Moved.Count == 0 && f.Ended.Count == 1 && !f.Ended[0].Cancelled,
                "alive excludes moves for known and unknown IDs before reconciliation");
            Near(f.Ended[0].X, 0.25f, "rejected move cannot mutate the ended touch");
            f.Deliver(Bundle(Touch(11, 0, 0.2f, 0.8f, ""), Touch(12, 0, 0.3f, 0.7f, ""), Frame(303, 5, 2, 1), Alive(11, 12)));
            f.Deliver(Bundle(Touch(11, 2, 0.4f, 0.6f, ""), Touch(12, 3, 0.5f, 0.5f, ""), Touch(13, 3, 0.5f, 0.5f, ""), Frame(303, 6, 0, 1), Alive()));
            Assert(f.Ended.Count == 3 && !f.Ended[1].Cancelled && f.Ended[2].Cancelled,
                "known end/cancel still apply when absent from alive; unknown cancel stays ignored");
            Near(f.Ended[1].X, 0.4f, "explicit end retains its coordinates");
            f.Deliver(Bundle(Touch(14, 1, 0.2f, 0.8f, "area"), Local(14, 1, 0.4f, 0.6f, "area"), Frame(303, 7, 1, 0)));
            Assert(f.Began.Count == 3 && !f.Receiver.Touches.ContainsKey(14), "touch dispatch waits for alive after frame");
            f.Deliver(Alive(14));
            Assert(f.Began.Count == 4 && f.Moved.Count == 1 && f.Receiver.Touches[14].HasLocalPosition && !f.Receiver.Ready,
                "alive confirms synthesized begin/move with local coordinates even when ready=0");
            Near(f.Began[3].LocalX, 0.4f, "local coordinates available before confirmed begin callback");
            f.Deliver(Bundle(Touch(15, 0, 0.5f, 0.5f, ""), Frame(303, 8, 1, 1)));
            f.Deliver(Bundle(Frame(303, 9, 0, 1), Alive()));
            Assert(f.Began.Count == 4 && f.Receiver.Touches.Count == 0, "incomplete frame cannot release a begin at a later alive");
        }
    }

    private static void CheckFilterListenerShutdown()
    {
        // Exercise shutdown, shutdown/re-enable, and catch-up iteration after a
        // callback cancels the receiver's live touches.
        for (int scenario = 0; scenario < 3; scenario++)
        {
            using (var f = new Fixture())
            {
                var filter = new WallTouchZoneFilter { receiver = f.Receiver, zoneName = "new" };
                var order = new List<string>();
                filter.OnTouchBegan.AddListener(t =>
                {
                    order.Add("begin:" + t.Id);
                    Call(f.Receiver, "OnDisable");
                    if (scenario == 1) Call(f.Receiver, "OnEnable");
                });
                filter.OnTouchEnded.AddListener(t =>
                {
                    Assert(t.Cancelled, "filter receives receiver shutdown cancel");
                    order.Add("end:" + t.Id);
                });
                filter.OnTouchMoved.AddListener(t => order.Add("move:" + t.Id));
                if (scenario == 2)
                {
                    f.Deliver(Bundle(Touch(1, 0, 0.2f, 0.8f, "new"), Touch(2, 0, 0.3f, 0.7f, "new"), Frame(101, 1, 2, 1), Alive(1, 2)));
                    Call(filter, "OnEnable");
                }
                else
                {
                    Call(filter, "OnEnable");
                    f.Deliver(Convert.FromBase64String(Session101Packet));
                    f.Deliver(Convert.FromBase64String(FilterMovePacket));
                }
                Assert(order.Count == 2 && order[0].StartsWith("begin:") && order[1].StartsWith("end:"),
                    "filter callback shutdown emits begin/cancel with no trailing move or stale catch-up begin: " + scenario);
                Assert(f.Receiver.Touches.Count == 0 && ((IDictionary)Field(filter, "_inside")).Count == 0,
                    "ended touch cannot be reinserted into filter: " + scenario);
                Call(filter, "OnDisable");
                Assert(order.Count == 2, "filter disable cannot cancel a ghost touch: " + scenario);
            }
        }
    }

    private static void CheckLifecycle()
    {
        using (var f = new Fixture())
        {
            f.Send(Bundle(Bundle(Touch(7, 0, 0.2f, 0.8f, "영역_2"))));
            f.AwaitPackets(1);
            Assert(f.Receiver.Touches.Count == 0, "touch waits for session frame");
            f.Send(Bundle(Local(7, 0, 0.4f, 0.6f, "영역_2")));
            f.Frame(101, 1, 1, new byte[0][], 7);
            f.AwaitFrame(101, 1);
            WallTouch first = f.Receiver.Touches[7];
            Assert(f.Receiver.Ready && f.Receiver.Connected && f.Began.Count == 1 && f.UnityBegan.Count == 1, "begin and connection");
            Assert(first.Zone == "영역_2" && first.HasLocalPosition, "zone and local position across packets");
            Near(f.Began[0].LocalX, 0.4f, "local coordinate ready at begin callback");
            Near(first.X, 0.2f, "global coordinate");
            f.Frame(101, 2, 1, new[] { Touch(7, 1, 0.3f, 0.7f, "영역_2"), Touch(8, 1, 0.5f, 0.5f, "") }, 7, 8);
            f.AwaitFrame(101, 2);
            Assert(f.Began.Count == 2 && f.Moved.Count == 2, "missed begin synthesizes begin then move");
            Assert(f.Began[1].Phase == WallTouchPhase.Begin && f.Moved[1].Phase == WallTouchPhase.Move, "phase snapshots");
            Assert(first.BeganTime <= first.LastUpdateTime && first.HasLocalPosition, "monotonic time and retained local data");
            Near(f.Began[0].X, 0.2f, "snapshot preserved");
            f.Frame(101, 3, 1, new[] { Touch(99, 2, 0.5f, 0.5f, "") }, 8);
            f.AwaitFrame(101, 3);
            Assert(f.Ended.Count == 1 && f.Ended[0].Id == 7 && !f.Ended[0].Cancelled, "alive reconciles lost end, unknown end ignored");
            f.Frame(202, 1, 1, new[] { Touch(8, 0, 0.1f, 0.9f, "new"), Local(8, 0, 0.2f, 0.8f, "new") }, 8);
            f.AwaitFrame(202, 1);
            Assert(f.Ended.Count == 2 && f.Ended[1].Cancelled && f.Receiver.Touches[8].Zone == "new", "session change cancels old touch before reused ID");
            Assert(f.Order[f.Order.Count - 2] == "end:8" && f.Order[f.Order.Count - 1] == "begin:8", "session event order");
            f.Frame(202, 1, 0, new[] { Touch(8, 3, 0.1f, 0.9f, "new") });
            f.Pump(40);
            Assert(f.Receiver.Ready && f.Receiver.Touches.Count == 1, "duplicate frame and its alive ignored");
            f.Frame(202, 2, 0, new[] { Touch(9, 0, 0.1f, 0.9f, "") }, 8, 9);
            f.AwaitFrame(202, 2);
            Assert(f.Receiver.Connected && !f.Receiver.Ready && f.Receiver.Touches.ContainsKey(9), "ready=0 heartbeat does not gate an explicitly sent touch");
            f.Frame(202, 3, 0, new[] { Touch(9, 3, 0.1f, 0.9f, "") }, 8);
            f.AwaitFrame(202, 3);
            Assert(f.Ended[f.Ended.Count - 1].Cancelled, "cancel flag");
            f.Frame(202, 4, 1, new[] { Touch(10, 0, float.NaN, 0.5f, ""), Touch(11, 0, 1.1f, 0.5f, ""), Touch(12, 5, 0.5f, 0.5f, "") });
            f.AwaitFrame(202, 4);
            Assert(f.Receiver.Touches.Count == 0 && !f.Ended[f.Ended.Count - 1].Cancelled, "empty alive and invalid coordinates/phases");
            // A malformed packet must not partially deliver its valid first touch.
            byte[] truncated = Bundle(Touch(13, 0, 0.5f, 0.5f, ""), Message("/invalid", "i", 1));
            Array.Resize(ref truncated, truncated.Length - 1);
            f.Send(truncated);
            f.Send(Message("/other/touch", "iiffs", 14, 0, 0.5f, 0.5f, ""));
            f.Frame(202, 5, 1, new byte[0][]);
            f.AwaitFrame(202, 5);
            Assert(f.Receiver.Touches.Count == 0, "malformed packet atomicity and prefix matching");
            f.Pump(1050);
            Assert(f.Receiver.PacketsPerSecond > 0, "packet rate");
        }
    }

    private static void CheckTimeoutAndShutdown()
    {
        using (var f = new Fixture())
        {
            f.Receiver.frameTimeout = 0.1f;
            f.Frame(303, 1, 1, new[] { Touch(1, 0, 0.1f, 0.9f, "") }, 1);
            f.AwaitFrame(303, 1);
            for (int i = 0; i < 5; i++) { f.Send(Message("/noise", "i", i)); f.Pump(30); }
            Assert(!f.Receiver.Connected && !f.Receiver.Ready && f.Receiver.Touches.Count == 0 && f.Ended[0].Cancelled, "frame timeout despite other UDP traffic");
            f.Frame(303, 1, 1, new[] { Touch(1, 0, 0.1f, 0.9f, "") }, 1);
            f.Pump(30);
            Assert(!f.Receiver.Connected && f.Receiver.Touches.Count == 0, "delayed duplicate cannot resurrect after timeout");
            f.Frame(303, 2, 1, new[] { Touch(2, 1, 0.2f, 0.8f, "") }, 2);
            f.AwaitFrame(303, 2);
            Thread thread = (Thread)Field(f.Receiver, "_thread");
            Call(f.Receiver, "OnDisable");
            Assert(!thread.IsAlive && !f.Receiver.Connected && f.Receiver.Touches.Count == 0 && f.Ended[f.Ended.Count - 1].Cancelled, "socket closes, worker joined, touches cancelled");
            using (var portProbe = new UdpClient(new IPEndPoint(IPAddress.Any, f.Receiver.port))) { }
            Call(f.Receiver, "OnEnable");
            Assert(f.Receiver.Session == 0 && !f.Receiver.Connected, "enable resets connection");
            f.Frame(404, 1, 1, new[] { Touch(1, 0, 0.5f, 0.5f, "") }, 1);
            f.AwaitFrame(404, 1);
            thread = (Thread)Field(f.Receiver, "_thread");
            Call(f.Receiver, "OnApplicationQuit");
            Assert(!thread.IsAlive && f.Receiver.Touches.Count == 0, "quit shutdown");
        }
        using (var f = new Fixture())
        {
            f.Receiver.frameTimeout = 0.1f;
            f.Send(Touch(20, 0, 0.5f, 0.5f, ""));
            f.AwaitPackets(1);
            Thread.Sleep(130); // Simulate Unity's main thread being occupied.
            f.Send(Touch(21, 0, 0.5f, 0.5f, ""));
            f.Frame(405, 1, 1, new byte[0][], 21);
            f.AwaitFrame(405, 1);
            Assert(!f.Receiver.Touches.ContainsKey(20) && f.Began.Count == 1, "expired pending frame events discarded");
        }
        using (var f = new Fixture())
        {
            f.Receiver.frameTimeout = 0.1f;
            f.Send(Touch(22, 0, 0.5f, 0.5f, ""));
            f.Pump(20);
            Thread.Sleep(130);
            f.Frame(406, 1, 1, new byte[0][]);
            f.AwaitFrame(406, 1);
            Assert(f.Began.Count == 0, "late frame without a new touch does not release expired pending events");
        }
    }

    private static void CheckFilterAndHelpers()
    {
        using (var f = new Fixture())
        {
            var filter = new WallTouchZoneFilter { receiver = f.Receiver, zoneName = "Menu_Left" };
            var began = new List<WallTouch>();
            var moved = new List<WallTouch>();
            var ended = new List<WallTouch>();
            filter.OnTouchBegan.AddListener(t => began.Add(t.Snapshot()));
            filter.OnTouchMoved.AddListener(t => moved.Add(t.Snapshot()));
            filter.OnTouchEnded.AddListener(t => ended.Add(t.Snapshot()));
            f.Frame(505, 1, 1, new[] { Touch(1, 0, 0.25f, 0.75f, "Menu_Left"), Touch(2, 0, 0.5f, 0.5f, "Menu_Left_2") }, 1, 2);
            f.AwaitFrame(505, 1);
            Call(filter, "OnEnable");
            Assert(began.Count == 1 && began[0].Id == 1, "filter enabled mid-touch, exact sanitized zone match");
            f.Frame(505, 2, 1, new[] { Touch(1, 1, 0.3f, 0.7f, "Other"), Touch(2, 1, 0.25f, 0.75f, "Menu_Left"), Local(2, 1, 0.5f, 0.25f, "Menu_Left") }, 1, 2);
            f.AwaitFrame(505, 2);
            Assert(ended.Count == 1 && ended[0].Zone == "Menu_Left" && began.Count == 2 && moved.Count == 1, "filter zone exit/entry lifecycle");
            WallTouch touch = f.Receiver.Touches[2];
            Near(f.Receiver.ToPixels(touch).x, 1440, "5760 pixel width");
            Near(f.Receiver.ToPixels(touch).y, 900, "1200 y-up height");
            Near(f.Receiver.ToScreen(touch).x, Screen.width * 0.25f, "screen resolution");
            var cam = new Camera();
            Near(f.Receiver.ToWorld(touch, cam, 4).z, 4, "world depth passed to camera");
            Near(cam.LastViewport.y, 0.75f, "world camera viewport");
            f.Receiver.senderYUp = false;
            Near(f.Receiver.ToPixels(touch, 800, 600).y, 150, "y-down sender conversion");
            f.Receiver.ToRay(touch, cam);
            Near(cam.LastViewport.y, 0.25f, "ray y-down conversion");
            Near(touch.Y, 0.75f, "helpers preserve raw received model");
            Call(filter, "OnDisable");
            Assert(ended.Count == 2 && ended[1].Cancelled && f.Receiver.Touches[2].Phase == WallTouchPhase.Move, "filter shutdown cancels its snapshot without mutating receiver");
            f.Frame(505, 3, 1, new[] { Touch(2, 1, 0.3f, 0.7f, "Menu_Left") }, 2);
            f.AwaitFrame(505, 3);
            Assert(moved.Count == 1, "disabled filter unsubscribed");
            var view = new WallTouchDebugView { receiver = f.Receiver };
            Event.current = new Event { type = EventType.Repaint };
            GUI.Markers = 0;
            Call(view, "OnGUI");
            Assert(GUI.Markers == 1, "overlay marker for active touch");
            Event.current = new Event { type = EventType.KeyDown, keyCode = KeyCode.F1 };
            Call(view, "OnGUI");
            Assert(!view.visible && Event.current.type == EventType.Used, "F1 hides overlay");
            Event.current = new Event { type = EventType.KeyDown, keyCode = KeyCode.F1 };
            Call(view, "OnGUI");
            Assert(view.visible, "F1 works while overlay hidden");
            Event.current = null;
        }
    }

    private static void CheckListenerShutdown()
    {
        using (var f = new Fixture())
        {
            f.Receiver.OnTouchBegan += t => Call(f.Receiver, "OnDisable");
            f.Send(Bundle(Touch(1, 1, 0.5f, 0.5f, ""), Frame(606, 1, 1, 1), Alive(1)));
            f.Pump(80);
            Assert(f.Receiver.Touches.Count == 0 && f.Moved.Count == 0 && f.Ended.Count == 1, "listener shutdown cannot emit move after cancel");
        }
    }

    private static void CheckBindError()
    {
        using (var blocker = new UdpClient())
        {
            blocker.ExclusiveAddressUse = true;
            blocker.Client.Bind(new IPEndPoint(IPAddress.Any, 0));
            var receiver = new WallTouchReceiver { port = ((IPEndPoint)blocker.Client.LocalEndPoint).Port };
            Call(receiver, "OnEnable");
            Assert(!receiver.Connected && !string.IsNullOrEmpty(receiver.LastError), "bind failure reported without background thread");
            Call(receiver, "OnDisable");
        }
    }

    private static void CheckCustomPrefix()
    {
        using (var f = new Fixture(" installation/ "))
        {
            f.Send(Bundle(
                Message("/wall/touch", "iiffs", 9, 0, 0.5f, 0.5f, ""),
                Message("/installation/touch", "iiffs", 1, 0, 0.25f, 0.75f, "area"),
                Message("/installation/zone/area/touch", "iiff", 1, 0, 0.5f, 0.5f),
                Message("/installation/frame", "iiii", 707, 1, 1, 1),
                Message("/installation/alive", "i", 1)));
            f.AwaitFrame(707, 1);
            Assert(f.Receiver.Touches.Count == 1 && f.Receiver.Touches[1].HasLocalPosition, "custom prefix normalized and isolated from other senders");
        }
    }

    private sealed class Fixture : IDisposable
    {
        public readonly WallTouchReceiver Receiver = new WallTouchReceiver();
        public readonly List<WallTouch> Began = new List<WallTouch>(), Moved = new List<WallTouch>(), Ended = new List<WallTouch>();
        public readonly List<WallTouch> UnityBegan = new List<WallTouch>();
        public readonly List<string> Order = new List<string>();
        private readonly UdpClient _sender = new UdpClient();
        private readonly int _mainThread = Thread.CurrentThread.ManagedThreadId;
        public Fixture(string customPrefix = null)
        {
            Assert(Receiver.port == 7000 && Receiver.prefix == "/wall" && Receiver.senderYUp && Receiver.frameTimeout == 1, "receiver defaults");
            if (customPrefix != null) Receiver.prefix = customPrefix;
            using (var portProbe = new UdpClient(new IPEndPoint(IPAddress.Any, 0)))
                Receiver.port = ((IPEndPoint)portProbe.Client.LocalEndPoint).Port;
            Receiver.frameTimeout = 2;
            Receiver.OnTouchBegan += t => Record(Began, "begin", t);
            Receiver.OnTouchMoved += t => Record(Moved, "move", t);
            Receiver.OnTouchEnded += t => Record(Ended, "end", t);
            Receiver.TouchBegan.AddListener(t => Record(UnityBegan, null, t));
            Receiver.TouchMoved.AddListener(t => Assert(Thread.CurrentThread.ManagedThreadId == _mainThread, "Unity move main thread"));
            Receiver.TouchEnded.AddListener(t => Assert(Thread.CurrentThread.ManagedThreadId == _mainThread, "Unity end main thread"));
            Call(Receiver, "OnEnable");
            Assert(Receiver.LastError == null && !Receiver.Connected && !Receiver.Ready, "initial receiver state");
        }
        private void Record(List<WallTouch> list, string kind, WallTouch touch)
        {
            Assert(Thread.CurrentThread.ManagedThreadId == _mainThread, "C#/Unity callback on main thread");
            list.Add(touch.Snapshot());
            if (kind != null) Order.Add(kind + ":" + touch.Id);
        }
        public void Send(byte[] packet) { _sender.Send(packet, packet.Length, new IPEndPoint(IPAddress.Loopback, Receiver.port)); }
        public void Deliver(byte[] packet)
        {
            IList parsed;
            double at = (double)Stopwatch.GetTimestamp() / Stopwatch.Frequency;
            Assert(Parse(packet, out parsed, at), "ordered regression packet parses");
            foreach (object message in parsed)
                typeof(WallTouchReceiver).GetMethod("HandleMessage", Private).Invoke(Receiver, new[] { message });
        }
        public void Frame(int session, int seq, int ready, byte[][] touches, params int[] ids)
        {
            var messages = new List<byte[]>(touches);
            messages.Add(ReceiverChecks.Frame(session, seq, ids.Length, ready));
            messages.Add(Alive(ids));
            Send(Bundle(messages.ToArray()));
        }
        public void AwaitFrame(int session, int seq)
        {
            Wait(() => Receiver.Session == session && (int)Field(Receiver, "_sequence") == seq && Receiver.Connected && !(bool)Field(Receiver, "_acceptAlive"), "frame " + seq);
        }
        public void AwaitPackets(long count) { Wait(() => (long)Field(Receiver, "_packetCount") >= count && (int)Field(Receiver, "_queuedCount") == 0, "packet receipt"); }
        private void Wait(Func<bool> condition, string description)
        {
            var timer = Stopwatch.StartNew();
            do { Call(Receiver, "Update"); if (condition()) return; Thread.Sleep(2); } while (timer.ElapsedMilliseconds < 1500);
            throw new Exception("Timed out waiting for " + description);
        }
        public void Pump(int milliseconds)
        {
            var timer = Stopwatch.StartNew();
            do { Call(Receiver, "Update"); Thread.Sleep(2); } while (timer.ElapsedMilliseconds < milliseconds);
        }
        public void Dispose() { Call(Receiver, "OnDisable"); _sender.Close(); }
    }

    private static byte[] Touch(int id, int phase, float x, float y, string zone) { return Message("/wall/touch", "iiffs", id, phase, x, y, zone); }
    private static byte[] Local(int id, int phase, float x, float y, string zone) { return Message("/wall/zone/" + zone + "/touch", "iiff", id, phase, x, y); }
    private static byte[] Frame(int session, int seq, int count, int ready) { return Message("/wall/frame", "iiii", session, seq, count, ready); }
    private static byte[] Alive(params int[] ids)
    {
        var args = new object[ids.Length];
        for (int i = 0; i < ids.Length; i++) args[i] = ids[i];
        return Message("/wall/alive", new string('i', ids.Length), args);
    }
    private static byte[] IntBytes(int value) { return new[] { (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value }; }
    private static void Write(MemoryStream output, byte[] bytes) { output.Write(bytes, 0, bytes.Length); }
    private static void Pad(MemoryStream output) { while ((output.Length & 3) != 0) output.WriteByte(0); }
    private static void Text(MemoryStream output, string value) { Write(output, Encoding.UTF8.GetBytes(value)); output.WriteByte(0); Pad(output); }
    private static void Numeric(MemoryStream output, byte[] bytes) { if (BitConverter.IsLittleEndian) Array.Reverse(bytes); Write(output, bytes); }
    private static byte[] Message(string address, string tags, params object[] args)
    {
        using (var output = new MemoryStream())
        {
            Text(output, address); Text(output, "," + tags);
            for (int i = 0; i < tags.Length; i++)
            {
                switch (tags[i])
                {
                    case 'i': Write(output, IntBytes((int)args[i])); break;
                    case 'f': Numeric(output, BitConverter.GetBytes((float)args[i])); break;
                    case 's': Text(output, (string)args[i]); break;
                    case 'h': case 't': Numeric(output, BitConverter.GetBytes((long)args[i])); break;
                    case 'd': Numeric(output, BitConverter.GetBytes((double)args[i])); break;
                    case 'T': case 'F': case 'N': break;
                    case 'b':
                        byte[] blob = (byte[])args[i];
                        Write(output, IntBytes(blob.Length)); Write(output, blob); Pad(output);
                        break;
                    default: throw new Exception("Unsupported test type");
                }
            }
            return output.ToArray();
        }
    }
    private static byte[] Bundle(params byte[][] packets)
    {
        using (var output = new MemoryStream())
        {
            Text(output, "#bundle"); Write(output, new byte[] { 0, 0, 0, 0, 0, 0, 0, 1 });
            foreach (byte[] packet in packets) { Write(output, IntBytes(packet.Length)); Write(output, packet); }
            return output.ToArray();
        }
    }
}
#endif
