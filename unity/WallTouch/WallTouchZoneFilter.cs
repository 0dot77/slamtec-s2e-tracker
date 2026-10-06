using System;
using System.Collections.Generic;
using UnityEngine;

/// <summary>Matches the exact OSC-sanitized zone name, including duplicate suffixes.</summary>
public sealed class WallTouchZoneFilter : MonoBehaviour
{
    public WallTouchReceiver receiver;
    public string zoneName = "zone";
    public WallTouchEvent OnTouchBegan = new WallTouchEvent();
    public WallTouchEvent OnTouchMoved = new WallTouchEvent();
    public WallTouchEvent OnTouchEnded = new WallTouchEvent();

    private readonly Dictionary<int, WallTouch> _inside = new Dictionary<int, WallTouch>();
    private WallTouchReceiver _subscribed;

    private void OnEnable()
    {
        if (receiver == null) receiver = GetComponent<WallTouchReceiver>();
        if (receiver == null) return;
        _subscribed = receiver;
        _subscribed.OnTouchBegan += Began;
        _subscribed.OnTouchMoved += Moved;
        _subscribed.OnTouchEnded += Ended;
        // Enabling the filter during an existing touch still yields a full lifecycle.
        var current = new List<WallTouch>(_subscribed.Touches.Values);
        foreach (WallTouch touch in current)
        {
            if (_subscribed == null) break; // A listener may disable the filter.
            Began(touch);
        }
    }

    private bool Matches(WallTouch touch) { return string.Equals(touch.Zone, zoneName, StringComparison.Ordinal); }
    private bool IsActive(WallTouch touch)
    {
        WallTouch current;
        return _subscribed != null && _subscribed.Connected &&
            _subscribed.Touches.TryGetValue(touch.Id, out current) && ReferenceEquals(current, touch);
    }
    private void Began(WallTouch touch)
    {
        if (!IsActive(touch) || !Matches(touch) || _inside.ContainsKey(touch.Id)) return;
        WallTouch copy = touch.Snapshot();
        copy.Phase = WallTouchPhase.Begin;
        _inside[copy.Id] = copy;
        OnTouchBegan.Invoke(copy.Snapshot());
    }

    private void Moved(WallTouch touch)
    {
        if (!IsActive(touch)) return;
        if (!Matches(touch))
        {
            Leave(touch.Id, false, touch.LastUpdateTime);
            return;
        }
        WallTouchReceiver subscribed = _subscribed;
        if (!_inside.ContainsKey(touch.Id)) Began(touch);
        // A begin listener may disable/re-enable either component, cancel this
        // touch, or change the filter. Never reinsert an ended touch afterward.
        if (_subscribed != subscribed || !IsActive(touch) || !Matches(touch) || !_inside.ContainsKey(touch.Id)) return;
        _inside[touch.Id] = touch.Snapshot();
        OnTouchMoved.Invoke(touch.Snapshot());
    }

    private void Ended(WallTouch touch)
    {
        if (!_inside.ContainsKey(touch.Id)) return;
        if (Matches(touch)) _inside[touch.Id] = touch.Snapshot();
        Leave(touch.Id, touch.Cancelled, touch.LastUpdateTime);
    }

    private void Leave(int id, bool cancelled, double at)
    {
        WallTouch touch;
        if (!_inside.TryGetValue(id, out touch)) return;
        _inside.Remove(id);
        touch.Phase = cancelled ? WallTouchPhase.Cancel : WallTouchPhase.End;
        touch.Cancelled = cancelled;
        touch.LastUpdateTime = at;
        OnTouchEnded.Invoke(touch);
    }

    private void OnDisable()
    {
        if (_subscribed != null)
        {
            _subscribed.OnTouchBegan -= Began;
            _subscribed.OnTouchMoved -= Moved;
            _subscribed.OnTouchEnded -= Ended;
            _subscribed = null;
        }
        var ids = new List<int>(_inside.Keys);
        double at = (double)System.Diagnostics.Stopwatch.GetTimestamp() / System.Diagnostics.Stopwatch.Frequency;
        foreach (int id in ids) Leave(id, true, at);
    }
}
