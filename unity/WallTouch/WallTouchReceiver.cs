using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using UnityEngine;
using UnityEngine.Events;

public enum WallTouchPhase { Begin = 0, Move = 1, End = 2, Cancel = 3 }

/// <summary>Mutable live state; use Snapshot() when retaining an event's state.
/// Times are monotonic seconds, independent of Unity's time scale.</summary>
[Serializable]
public sealed class WallTouch
{
    public int Id { get; internal set; }
    public WallTouchPhase Phase { get; internal set; }
    public float X { get; internal set; }
    public float Y { get; internal set; }
    public string Zone { get; internal set; }
    public float LocalX { get; internal set; }
    public float LocalY { get; internal set; }
    public bool HasLocalPosition { get; internal set; }
    public double BeganTime { get; internal set; }
    public double LastUpdateTime { get; internal set; }
    public bool Cancelled { get; internal set; }

    public WallTouch Snapshot() { return (WallTouch)MemberwiseClone(); }
}

[Serializable]
public sealed class WallTouchEvent : UnityEvent<WallTouch> { }

/// <summary>Dependency-free OSC/UDP receiver. Public state, events and helpers
/// are for the Unity main thread. The worker only parses bytes and queues messages.</summary>
[DisallowMultipleComponent]
public sealed class WallTouchReceiver : MonoBehaviour
{
    [Header("OSC input (applied on enable)")]
    [Range(1, 65535)] public int port = 7000;
    public string prefix = "/wall";
    public bool senderYUp = true;
    [Min(0.1f)] public float frameTimeout = 1.0f;

    [Header("Unity events (C# events are OnTouchBegan/Moved/Ended)")]
    public WallTouchEvent TouchBegan = new WallTouchEvent();
    public WallTouchEvent TouchMoved = new WallTouchEvent();
    public WallTouchEvent TouchEnded = new WallTouchEvent();

    public event Action<WallTouch> OnTouchBegan;
    public event Action<WallTouch> OnTouchMoved;
    public event Action<WallTouch> OnTouchEnded;

    public IReadOnlyDictionary<int, WallTouch> Touches
    {
        get
        {
            if (_view == null) _view = new ReadOnlyDictionary<int, WallTouch>(_touches);
            return _view;
        }
    }
    public bool Connected { get { return _running && _hasFrame && Now() - _lastFrameAt <= TimeoutSeconds; } }
    public bool Ready { get { return _ready && Connected; } }
    public int Session { get; private set; }
    public float PacketsPerSecond { get; private set; }
    public string LastError { get; private set; }

    private const int MaxQueuedMessages = 8192;
    private const int MaxPendingMessages = 4096;
    private const int MaxRetiredSessions = 16;
    private readonly ConcurrentQueue<OscMessage> _inbox = new ConcurrentQueue<OscMessage>();
    private readonly Dictionary<int, WallTouch> _touches = new Dictionary<int, WallTouch>();
    private readonly List<OscMessage> _pending = new List<OscMessage>();
    private readonly HashSet<int> _retiredSessions = new HashSet<int>();
    private readonly Queue<int> _retiredSessionOrder = new Queue<int>();
    private OscMessage[] _framePending;
    private ReadOnlyDictionary<int, WallTouch> _view;
    private UdpClient _socket;
    private Thread _thread;
    private volatile bool _running;
    private int _queuedCount;
    private long _packetCount;
    private string _workerError;
    private string _touchAddress, _frameAddress, _aliveAddress, _zonePrefix;
    private bool _ready, _hasFrame, _hasSequence, _acceptAlive;
    private int _sequence;
    private double _lastFrameAt, _rateAt;

    private double TimeoutSeconds
    {
        get { return float.IsNaN(frameTimeout) || float.IsInfinity(frameTimeout) ? 1.0 : Math.Max(0.1, frameTimeout); }
    }
    private static double Now() { return (double)Stopwatch.GetTimestamp() / Stopwatch.Frequency; }

    private void OnEnable()
    {
        StopReceiver();
        LastError = null;
        Session = 0;
        _hasSequence = false;
        string root = string.IsNullOrWhiteSpace(prefix) ? "/wall" : prefix.Trim();
        if (!root.StartsWith("/", StringComparison.Ordinal)) root = "/" + root;
        root = root.TrimEnd('/');
        _touchAddress = root + "/touch";
        _frameAddress = root + "/frame";
        _aliveAddress = root + "/alive";
        _zonePrefix = root + "/zone/";
        _rateAt = Now();
        Interlocked.Exchange(ref _packetCount, 0);
        try
        {
            if (port < 1 || port > 65535) throw new ArgumentOutOfRangeException("port");
            _socket = new UdpClient(new IPEndPoint(IPAddress.Any, port));
            _socket.Client.ReceiveTimeout = 250;
            _running = true;
            UdpClient socket = _socket;
            _thread = new Thread(delegate() { ReceiveLoop(socket); });
            _thread.IsBackground = true;
            _thread.Name = "WallTouch OSC UDP";
            _thread.Start();
        }
        catch (Exception error)
        {
            StopReceiver();
            LastError = error.Message;
            UnityEngine.Debug.LogError("WallTouch: cannot listen on UDP " + port + ": " + LastError, this);
        }
    }

    private void ReceiveLoop(UdpClient socket)
    {
        var remote = new IPEndPoint(IPAddress.Any, 0);
        var messages = new List<OscMessage>();
        while (_running)
        {
            try
            {
                byte[] packet = socket.Receive(ref remote);
                Interlocked.Increment(ref _packetCount);
                messages.Clear();
                if (!OscParser.TryParse(packet, Now(), messages) || messages.Count == 0) continue;
                // Drop whole packets on overflow; never deliver a partial bundle.
                if (Interlocked.Add(ref _queuedCount, messages.Count) > MaxQueuedMessages)
                {
                    Interlocked.Add(ref _queuedCount, -messages.Count);
                    continue;
                }
                foreach (OscMessage message in messages) _inbox.Enqueue(message);
            }
            catch (SocketException error)
            {
                if (!_running) break;
                if (error.SocketErrorCode == SocketError.TimedOut || error.SocketErrorCode == SocketError.WouldBlock) continue;
                Interlocked.Exchange(ref _workerError, error.Message);
                break;
            }
            catch (ObjectDisposedException) { break; }
        }
    }

    private void Update()
    {
        string error = Interlocked.Exchange(ref _workerError, null);
        if (error != null)
        {
            StopReceiver();
            LastError = error;
            UnityEngine.Debug.LogError("WallTouch UDP: " + error, this);
            return;
        }
        double now = Now();
        if (_hasFrame && now - _lastFrameAt > TimeoutSeconds) Expire(now);
        OscMessage message;
        // Bound work even if a sender continuously floods the socket.
        for (int i = 0; i < MaxQueuedMessages && _running && _inbox.TryDequeue(out message); i++)
        {
            Interlocked.Decrement(ref _queuedCount);
            if (now - message.ReceivedAt > TimeoutSeconds) continue;
            HandleMessage(message);
        }
        if (_pending.Count > 0 && now - _pending[0].ReceivedAt > TimeoutSeconds) _pending.Clear();
        if (now - _rateAt >= 1.0)
        {
            PacketsPerSecond = (float)(Interlocked.Exchange(ref _packetCount, 0) / (now - _rateAt));
            _rateAt = now;
        }
    }

    private void HandleMessage(OscMessage message)
    {
        if (message.Address == _frameAddress)
        {
            if (message.Tags != ",iiii") return;
            int session = (int)message.Args[0], sequence = (int)message.Args[1];
            int count = (int)message.Args[2], ready = (int)message.Args[3];
            if (session <= 0 || count < 0 || (ready != 0 && ready != 1)) return;
            // Touches precede /frame: wait for it to identify their session.
            if (_pending.Count > 0 && message.ReceivedAt - _pending[0].ReceivedAt > TimeoutSeconds)
                _pending.Clear();
            OscMessage[] pending = _pending.ToArray();
            _pending.Clear();
            _framePending = null;
            _acceptAlive = false;
            // Sessionless touch/local messages belong to this completing frame.
            // Discard them and its following /alive if the session was retired.
            if (_retiredSessions.Contains(session)) return;
            if (Session != session)
            {
                if (Session > 0)
                {
                    _retiredSessions.Add(Session);
                    _retiredSessionOrder.Enqueue(Session);
                    if (_retiredSessionOrder.Count > MaxRetiredSessions)
                        _retiredSessions.Remove(_retiredSessionOrder.Dequeue());
                }
                EndAll(true, message.ReceivedAt);
                Session = session;
                _hasSequence = false;
            }
            if (_hasSequence && unchecked(sequence - _sequence) <= 0)
            {
                _acceptAlive = false;
                return;
            }
            _sequence = sequence;
            _hasSequence = true;
            _hasFrame = true;
            _lastFrameAt = message.ReceivedAt;
            _ready = ready == 1;
            _acceptAlive = true;
            _framePending = pending;
        }
        else if (message.Address == _aliveAddress)
        {
            if (!_acceptAlive || !_hasFrame) return;
            for (int i = 1; i < message.Tags.Length; i++) if (message.Tags[i] != 'i') return;
            var alive = new HashSet<int>();
            foreach (object argument in message.Args) alive.Add((int)argument);
            OscMessage[] pending = _framePending;
            _framePending = null;
            _acceptAlive = false;
            var locals = new Dictionary<int, OscMessage>();
            foreach (OscMessage item in pending)
                if (item.Address != _touchAddress) locals[(int)item.Args[0]] = item;
            foreach (OscMessage item in pending)
            {
                if (!_running) break;
                if (item.Address != _touchAddress) continue;
                int id = (int)item.Args[0], phase = (int)item.Args[1];
                // A late body bundle can land in the next frame. Its begin/move
                // must never create/update a touch absent from that frame's alive.
                if ((phase == (int)WallTouchPhase.Begin || phase == (int)WallTouchPhase.Move) && !alive.Contains(id)) continue;
                OscMessage local;
                locals.TryGetValue(id, out local);
                ApplyTouch(item, local);
            }
            var missing = new List<int>();
            foreach (int id in _touches.Keys) if (!alive.Contains(id)) missing.Add(id);
            foreach (int id in missing) EndTouch(id, false, message.ReceivedAt);
        }
        else if (message.Address == _touchAddress)
        {
            if (message.Tags != ",iiffs" || !ValidTouch(message)) return;
            Stage(message);
        }
        else if (message.Address.StartsWith(_zonePrefix, StringComparison.Ordinal) && message.Address.EndsWith("/touch", StringComparison.Ordinal))
        {
            if (message.Address.Length <= _zonePrefix.Length + 6) return;
            string zone = message.Address.Substring(_zonePrefix.Length, message.Address.Length - _zonePrefix.Length - 6);
            if (zone.Length == 0 || zone.IndexOf('/') >= 0 || message.Tags != ",iiff" || !ValidTouch(message)) return;
            message.Zone = zone;
            Stage(message);
        }
    }

    private static bool ValidTouch(OscMessage message)
    {
        int phase = (int)message.Args[1];
        float x = (float)message.Args[2], y = (float)message.Args[3];
        return phase >= 0 && phase <= 3 && x >= 0 && x <= 1 && y >= 0 && y <= 1;
    }

    private void Stage(OscMessage message)
    {
        _acceptAlive = false;
        _framePending = null;
        // A missing final bundle must not leave old events waiting indefinitely.
        if (_pending.Count > 0 && message.ReceivedAt - _pending[0].ReceivedAt > TimeoutSeconds)
            _pending.Clear();
        if (_pending.Count >= MaxPendingMessages) _pending.Clear();
        _pending.Add(message);
    }

    private void ApplyTouch(OscMessage message, OscMessage local)
    {
        int id = (int)message.Args[0];
        var phase = (WallTouchPhase)(int)message.Args[1];
        WallTouch touch;
        bool exists = _touches.TryGetValue(id, out touch);
        if (!exists && (phase == WallTouchPhase.End || phase == WallTouchPhase.Cancel)) return;
        if (!exists)
        {
            touch = new WallTouch { Id = id, BeganTime = message.ReceivedAt };
            _touches.Add(id, touch);
        }
        touch.X = (float)message.Args[2];
        touch.Y = (float)message.Args[3];
        string zone = (string)message.Args[4];
        // A zone transition must not reuse the previous zone's local coordinates.
        if (!exists || touch.Zone != zone || zone.Length == 0)
        {
            touch.LocalX = touch.X;
            touch.LocalY = touch.Y;
            touch.HasLocalPosition = false;
        }
        touch.Zone = zone;
        touch.LastUpdateTime = message.ReceivedAt;
        if (local != null && local.Zone == zone && (int)local.Args[1] == (int)phase)
        {
            touch.LocalX = (float)local.Args[2];
            touch.LocalY = (float)local.Args[3];
            touch.HasLocalPosition = true;
        }
        if (phase == WallTouchPhase.End || phase == WallTouchPhase.Cancel)
        {
            EndTouch(id, phase == WallTouchPhase.Cancel, message.ReceivedAt);
            return;
        }
        if (!exists)
        {
            touch.Phase = WallTouchPhase.Begin;
            if (OnTouchBegan != null) OnTouchBegan(touch);
            if (!IsActive(touch)) return; // A listener may disable/re-enable the receiver.
            TouchBegan.Invoke(touch);
            if (!IsActive(touch)) return;
            if (phase == WallTouchPhase.Begin) return;
        }
        touch.Phase = WallTouchPhase.Move;
        if (OnTouchMoved != null) OnTouchMoved(touch);
        if (!IsActive(touch)) return;
        TouchMoved.Invoke(touch);
    }

    private bool IsActive(WallTouch touch)
    {
        WallTouch current;
        return _running && _touches.TryGetValue(touch.Id, out current) && ReferenceEquals(current, touch);
    }

    private void EndTouch(int id, bool cancelled, double at)
    {
        WallTouch touch;
        if (!_touches.TryGetValue(id, out touch)) return;
        _touches.Remove(id);
        touch.Phase = cancelled ? WallTouchPhase.Cancel : WallTouchPhase.End;
        touch.Cancelled = cancelled;
        touch.LastUpdateTime = at;
        if (OnTouchEnded != null) OnTouchEnded(touch);
        TouchEnded.Invoke(touch);
    }

    private void EndAll(bool cancelled, double at)
    {
        var ids = new List<int>(_touches.Keys);
        foreach (int id in ids) EndTouch(id, cancelled, at);
    }

    private void Expire(double now)
    {
        _ready = _hasFrame = _acceptAlive = false;
        _framePending = null;
        // Keep the last sequence until a new session/enable, so delayed duplicate
        // frames cannot resurrect touches after a timeout.
        _pending.Clear();
        EndAll(true, now);
    }

    public Vector2 ToScreen(WallTouch touch) { return ToPixels(touch, Screen.width, Screen.height); }
    public Vector2 ToPixels(WallTouch touch, int width = 5760, int height = 1200)
    {
        if (touch == null) throw new ArgumentNullException("touch");
        return new Vector2(touch.X * width, (senderYUp ? touch.Y : 1f - touch.Y) * height);
    }
    public Vector3 ToWorld(WallTouch touch, Camera cam, float depth)
    {
        if (touch == null) throw new ArgumentNullException("touch");
        if (cam == null) throw new ArgumentNullException("cam");
        return cam.ViewportToWorldPoint(new Vector3(touch.X, senderYUp ? touch.Y : 1f - touch.Y, depth));
    }
    public Ray ToRay(WallTouch touch, Camera cam)
    {
        if (touch == null) throw new ArgumentNullException("touch");
        if (cam == null) throw new ArgumentNullException("cam");
        return cam.ViewportPointToRay(new Vector3(touch.X, senderYUp ? touch.Y : 1f - touch.Y, 0));
    }

    private void OnDisable() { StopReceiver(); }
    private void OnApplicationQuit() { StopReceiver(); }
    private void StopReceiver()
    {
        _running = false;
        if (_socket != null)
        {
            try { _socket.Close(); }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
            _socket = null;
        }
        if (_thread != null)
        {
            if ((_thread.ThreadState & System.Threading.ThreadState.Unstarted) == 0)
                _thread.Join(); // Close + the receive timeout unblock Receive().
            _thread = null;
        }
        OscMessage ignored;
        while (_inbox.TryDequeue(out ignored)) { }
        Interlocked.Exchange(ref _queuedCount, 0);
        Interlocked.Exchange(ref _workerError, null);
        PacketsPerSecond = 0;
        Expire(Now());
    }

    private sealed class OscMessage
    {
        public string Address, Tags, Zone;
        public object[] Args;
        public double ReceivedAt;
    }

    private static class OscParser
    {
        private const int MaxDepth = 32;
        private const int MaxMessages = 2048;
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

        [StructLayout(LayoutKind.Explicit)]
        private struct FloatBits
        {
            [FieldOffset(0)] public int Int;
            [FieldOffset(0)] public float Float;
        }

        public static bool TryParse(byte[] data, double at, List<OscMessage> output)
        {
            if (data == null || data.Length == 0 || data.Length > 65507) return false;
            try { return ParseElement(data, 0, data.Length, 0, at, output); }
            catch (DecoderFallbackException) { return false; }
        }

        private static bool ParseElement(byte[] data, int start, int end, int depth, double at, List<OscMessage> output)
        {
            if (depth > MaxDepth || end <= start || ((end - start) & 3) != 0) return false;
            int cursor = start;
            string address;
            if (!ReadString(data, start, ref cursor, end, out address)) return false;
            if (address == "#bundle")
            {
                if (!Skip(ref cursor, end, 8)) return false; // timetag; contract uses immediate
                while (cursor < end)
                {
                    int length;
                    if (!ReadInt(data, ref cursor, end, out length) || length <= 0 || length > end - cursor) return false;
                    if (!ParseElement(data, cursor, cursor + length, depth + 1, at, output)) return false;
                    cursor += length;
                }
                return true;
            }
            if (address.Length == 0 || address[0] != '/') return false;
            string tags;
            if (!ReadString(data, start, ref cursor, end, out tags) || tags.Length == 0 || tags[0] != ',') return false;
            var args = new object[tags.Length - 1];
            for (int i = 1; i < tags.Length; i++)
            {
                int bits;
                switch (tags[i])
                {
                    case 'i':
                        if (!ReadInt(data, ref cursor, end, out bits)) return false;
                        args[i - 1] = bits;
                        break;
                    case 'f':
                        if (!ReadInt(data, ref cursor, end, out bits)) return false;
                        args[i - 1] = new FloatBits { Int = bits }.Float;
                        break;
                    case 's':
                        string value;
                        if (!ReadString(data, start, ref cursor, end, out value)) return false;
                        args[i - 1] = value;
                        break;
                    case 'h': case 'd': case 't':
                        if (!Skip(ref cursor, end, 8)) return false;
                        break;
                    case 'T': case 'F': case 'N': break;
                    case 'b':
                        int length;
                        if (!ReadInt(data, ref cursor, end, out length) || length < 0 || length > end - cursor) return false;
                        if (!Skip(ref cursor, end, length)) return false;
                        while (((cursor - start) & 3) != 0)
                        {
                            if (cursor >= end || data[cursor++] != 0) return false;
                        }
                        break;
                    default: return false; // Unknown width: discard, never guess the offset.
                }
            }
            if (cursor != end || output.Count >= MaxMessages) return false;
            output.Add(new OscMessage { Address = address, Tags = tags, Args = args, ReceivedAt = at });
            return true;
        }

        private static bool ReadString(byte[] data, int start, ref int cursor, int end, out string value)
        {
            value = null;
            int first = cursor;
            while (cursor < end && data[cursor] != 0) cursor++;
            if (cursor == end) return false;
            value = Utf8.GetString(data, first, cursor - first);
            cursor++;
            while (((cursor - start) & 3) != 0)
                if (cursor >= end || data[cursor++] != 0) return false;
            return true;
        }

        private static bool ReadInt(byte[] data, ref int cursor, int end, out int value)
        {
            value = 0;
            if (end - cursor < 4) return false;
            value = unchecked((data[cursor] << 24) | (data[cursor + 1] << 16) | (data[cursor + 2] << 8) | data[cursor + 3]);
            cursor += 4;
            return true;
        }

        private static bool Skip(ref int cursor, int end, int length)
        {
            if (length < 0 || length > end - cursor) return false;
            cursor += length;
            return true;
        }
    }
}
