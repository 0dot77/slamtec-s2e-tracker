# Unity 벽 터치 수신기

Unity **2021.3 이상**에서 사용하는 OSC/UDP 수신기입니다. extOSC·OscJack 같은 외부 패키지 없이 동작합니다. [Unity 2021.3의 C# 9 지원 범위](https://docs.unity3d.com/2021.3/Documentation/Manual/CSharpCompiler.html) 안에서 작성했습니다. 수신 스레드는 OSC 메시지와 중첩 bundle을 해석하고, 수신 데이터로 인한 상태 변경과 이벤트는 main thread의 `Update()`에서 처리합니다. 비활성화·종료 때의 cancel도 main thread에서 전달합니다.

## 설치

1. 이 `WallTouch` 폴더를 Unity 프로젝트의 `Assets/WallTouch`로 복사합니다.
2. 빈 GameObject를 만들고 **WallTouchReceiver**를 추가합니다. Port=`7000`, Prefix=`/wall`, Sender Y Up=`true`, Frame Timeout=`1`초가 기본값입니다. Port/Prefix를 바꾼 뒤에는 컴포넌트를 비활성화했다 다시 활성화합니다.
3. 트래커 앱에서 OSC를 활성화하고 Mode=`touch` 또는 `both`, Port=`7000`, Prefix=`/wall`, Y Up=`true`로 설정합니다. 같은 PC면 Host=`127.0.0.1`, 다른 PC면 **Unity 수신 PC의 IP**를 사용합니다.
4. 벽 설치·배경 학습·TL→TR→BR→BL 캘리브레이션을 마치고 Wall view에서 터치 영역을 그립니다. 활성 터치 영역이 없으면 화면 전체를 받습니다.
5. 같은 GameObject에 **WallTouchDebugView**를 추가해 Play를 누릅니다. Game view에 포커스를 두고 F1으로 overlay를 켜고 끕니다. 각 터치의 위치·ID·OSC 영역 이름과 Connected/Ready, Session, 초당 수신 UDP packet 수를 표시합니다. 한 frame이 여러 packet이면 packets/s는 scan Hz보다 높을 수 있습니다.
6. **WallTouchZoneFilter**를 필요한 영역마다 추가합니다. Receiver를 연결하고 Zone Name에 OSC로 정리된 이름을 입력합니다. UnityEvent의 dynamic `WallTouch` 인자로 이벤트를 연결하거나 아래 C# 예제를 사용합니다.

Windows Defender 방화벽에서 **Unity Editor와 빌드한 Unity 실행 파일에 인바운드 UDP 7000**을 허용하세요. 포트를 변경하면 해당 포트를 허용합니다. 다른 PC에서 보낼 경우 사용 중인 네트워크 프로필에도 규칙이 적용되는지 확인합니다. UDP 수신 포트는 한 수신기만 사용합니다. 포트를 이미 사용 중이면 Console과 `LastError`에 오류가 표시됩니다.

## 화면과 좌표

3대의 프로젝터를 합친 **5760×1200 = 4.8:1** 화면에서는 NVIDIA Surround를 구성해 Unity가 **하나의 큰 디스플레이**로 출력하도록 사용할 수 있습니다. [NVIDIA Surround 설정](https://www.nvidia.com/content/Control-Panel-Help/vLatest/en-gb/mergedProjects/nv3dENG/To_configure_my_displays_for_Surround.htm)에서 디스플레이 순서와 합친 해상도를 확인하고, Unity Game view와 player의 출력 비율도 맞춥니다. 프로젝터 블렌딩·워핑은 별도로 구성한 뒤 최종 투사 화면의 네 모서리를 캘리브레이션합니다. `ToScreen()`은 현재 Unity 출력의 전체 폭/높이를 사용합니다. 디스플레이를 각각 따로 출력하면 콘텐츠에 맞는 별도 디스플레이/카메라 매핑이 필요합니다.

`WallTouch.X/Y`와 `LocalX/LocalY`는 **수신한 값 그대로**입니다. 기본 송신 `yUp=true`에서는 `(0,0)`이 왼쪽 아래, `(1,1)`이 오른쪽 위입니다. 송신기를 `yUp=false`로 설정했으면 수신기 `senderYUp=false`도 설정합니다. 이 플래그는 변환 helper에서 y를 뒤집으며 원본 모델은 바꾸지 않습니다.

| Helper | 반환값 |
| --- | --- |
| `ToScreen(t)` | `Screen.width/height` 기준 화면 좌표, 왼쪽 아래 원점 |
| `ToPixels(t, width=5760, height=1200)` | 지정한 화면 크기의 pixel 좌표, 왼쪽 아래 원점 |
| `ToWorld(t, cam, depth)` | 카메라 전체 viewport에 대응하는 world 위치. depth는 카메라로부터의 z 거리(world 단위) |
| `ToRay(t, cam)` | 카메라 전체 viewport의 해당 위치를 통과하는 ray; 벽 collider와 raycast할 때 사용 |

카메라 helper는 전달한 카메라의 전체 viewport에 투사 영역을 매핑합니다. 카메라를 화면 일부에 배치한 경우 이 매핑을 기준으로 콘텐츠를 구성하세요. 화면 좌표 `1`은 폭/높이 가장자리로 변환되므로 배열 인덱스로 쓰려면 별도 범위 처리가 필요합니다. `OnGUI`는 왼쪽 위 원점이어서 debug view는 그릴 때 y를 한 번 더 뒤집습니다. 카메라 좌표와 depth 정의는 [Unity ViewportToWorldPoint](https://docs.unity3d.com/2021.3/Documentation/ScriptReference/Camera.ViewportToWorldPoint.html), ray는 [ViewportPointToRay](https://docs.unity3d.com/2021.3/Documentation/ScriptReference/Camera.ViewportPointToRay.html)를 참고하세요.

## API와 예제

`Touches`는 활성 터치의 `IReadOnlyDictionary<int, WallTouch>`입니다. 각 터치는 `Id`, `Phase`(Begin/Move/End/Cancel), `X/Y`, `Zone`, `LocalX/LocalY`, `HasLocalPosition`, `BeganTime`, `LastUpdateTime`, `Cancelled`를 가집니다. 시간은 timeScale과 무관한 monotonic 초 단위입니다. 영역 내부 메시지가 없을 때 local 좌표는 초기 전역 좌표로 대체되고 `HasLocalPosition=false`입니다. 영역 메시지가 일부 손실되면 동일 영역의 마지막 local 좌표를 유지할 수 있습니다.

C# 이벤트는 `OnTouchBegan`, `OnTouchMoved`, `OnTouchEnded`입니다. Receiver의 Inspector UnityEvents는 `TouchBegan`, `TouchMoved`, `TouchEnded`입니다. cancel은 `OnTouchEnded`/`TouchEnded`로 전달되며 `Cancelled=true`, `Phase=Cancel`입니다. 모델은 이후 frame에서 갱신되므로 이벤트 당시 값을 보관할 때 `t.Snapshot()`을 사용하세요. 컬렉션·모델·helper는 main thread에서 사용합니다.

```csharp
using UnityEngine;

public sealed class WallInteraction : MonoBehaviour
{
    public WallTouchReceiver receiver;
    public Camera wallCamera;

    private void OnEnable()
    {
        receiver.OnTouchBegan += Began;
        receiver.OnTouchMoved += Moved;
        receiver.OnTouchEnded += Ended;
    }

    private void OnDisable()
    {
        receiver.OnTouchBegan -= Began;
        receiver.OnTouchMoved -= Moved;
        receiver.OnTouchEnded -= Ended;
    }

    private void Began(WallTouch t)
    {
        Vector2 pixel = receiver.ToScreen(t);
        Debug.Log($"Begin #{t.Id} zone={t.Zone} pixel={pixel}");
    }

    private void Moved(WallTouch t)
    {
        Ray ray = receiver.ToRay(t, wallCamera);
        RaycastHit hit;
        if (Physics.Raycast(ray, out hit))
            Debug.DrawLine(ray.origin, hit.point, Color.cyan);
    }

    private void Ended(WallTouch t)
    {
        Debug.Log($"End #{t.Id}, cancelled={t.Cancelled}");
        // 이 ID에 연결한 드래그·버튼·효과를 해제합니다.
    }
}
```

Zone filter는 정확한 OSC 이름으로 비교합니다. 공백과 `# * , / ? [ ] { }`의 연속이 `_`로 바뀌고 양끝 `_`가 제거되며, 빈 결과는 `zone`, 중복은 목록 순서대로 `_2`, `_3`, …입니다. 예를 들어 `Menu / Left`는 `Menu_Left`입니다. Filter의 `OnTouchBegan/Moved/Ended`는 UnityEvents입니다. 진행 중인 터치에 filter를 활성화하면 begin을 전달하고, 같은 ID가 다른 zone으로 이동하면 이전 filter에는 end, 새 filter에는 begin을 전달합니다. Filter를 비활성화하면 자신이 받은 터치를 cancel로 정리합니다. Begin 콜백에서 receiver나 filter를 비활성화해 터치가 cancel되면 뒤따르는 move를 전달하거나 종료된 터치를 다시 보관하지 않습니다.

## 패킷 손실과 연결 상태

`Connected`는 timeout 안에 `/frame`을 받았는지, `Ready`는 연결되어 있고 마지막 frame의 ready가 `1`인지 나타냅니다. 센서가 멈추면 송신기는 약 300 ms 후 터치를 cancel하고 ready=`0` heartbeat를 500 ms마다 보냅니다. 따라서 Connected=true이면서 Ready=false일 수 있습니다. `requireReady=false`인 송신 설정은 Ready=false여도 터치를 보낼 수 있으며 수신기는 해당 메시지를 처리합니다.

- 세션 변경: 기존 터치를 모두 cancel한 뒤 새 세션의 메시지를 처리합니다. 최근 종료된 세션 16개를 기억해 해당 세션의 지연된 frame과 그 frame에 속한 touch·zone-touch·alive를 무시합니다. ID는 session과 함께 해석하세요.
- `/alive`: 같은 frame의 목록에 있는 ID만 begin/move를 전달한 뒤 목록에서 빠진 터치를 end로 정리합니다. 빈 목록도 처리합니다. 앞선 touch bundle이 늦게 도착해 다음 frame까지 남아 있어도 그 frame의 목록에 없으면 begin을 전달하지 않습니다. 기존 ID의 명시적 end/cancel은 목록에서 빠져 있어도 처리합니다.
- 알 수 없는 ID의 move: 같은 frame의 `/alive`에 있으면 begin을 합성하고 move를 전달합니다. 알 수 없는 end/cancel은 무시합니다.
- `/frame` timeout(기본 1초): 기존 터치를 모두 cancel합니다. 다른 OSC packet 수신만으로 timeout이 연장되지는 않습니다.
- 종료/비활성화: UDP 소켓을 닫고 수신 스레드를 join하며 터치를 cancel합니다. 다시 활성화하면 소켓을 다시 엽니다.

직접 OSC 메시지와 중첩 bundle 모두 지원하고 int32/float32/UTF-8 string을 big-endian으로 읽습니다. `h, d, T, F, N, b, t`는 정해진 폭으로 안전하게 건너뜁니다. 알 수 없는 type tag, 잘린 데이터, 잘못된 string/blob/bundle은 packet 전체를 버립니다. 큐와 중첩 깊이에 제한이 있어 입력이 밀리면 일부 packet을 버릴 수 있습니다. Touch와 zone-touch는 뒤따르는 `/frame`으로 세션을 확인하고 바로 뒤의 `/alive`까지 기다려 local 좌표와 활성 ID를 확인한 뒤 전달하므로 자체 송신기도 touch → zone-touch → frame → alive 순서를 지켜야 합니다. `/alive`가 없는 미완성 frame의 touch는 전달하지 않습니다. 이 수신기는 `slots` 모드를 소비하지 않습니다.

## 수신기 검증

저장소에서 Windows PowerShell로 `./unity/WallTouch/Tests/Verify-Receiver.ps1`을 실행하면 설치된 .NET Framework 4.x compiler와 최소 Unity API stub을 이용해 세 C# 파일을 컴파일하고 실제 loopback UDP, 중첩 bundle, malformed packet, 손실 복구, timeout, 종료/재시작, 좌표 변환과 zone filter를 검사합니다. 리뷰어의 실제 osc.js packet으로 세션 역행과 콜백 중 종료를 재현하며 bundle 순서 역전과 최근 종료된 세션 기록의 크기도 검증합니다. 외부 패키지를 설치하지 않으며 테스트 임시 출력은 `Tests` 폴더 안에 생성한 후 제거합니다. 테스트 C# 파일은 `WALL_TOUCH_RECEIVER_TEST` 심볼을 정의할 때만 컴파일되므로 폴더 전체를 Assets에 복사해도 Unity API와 충돌하지 않습니다. Unity Editor에서는 실제 씬·카메라·Inspector 이벤트·프로젝터 출력도 별도로 확인하세요.
