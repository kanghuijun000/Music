# MUSIQ

YouTube의 **음악 카테고리(카테고리 ID 10)** 영상만 검색하고, 선택한 영상은 YouTube 공식 내장 플레이어로 재생하는 테스트용 웹 앱입니다.

## 기능
- 노래 제목 또는 가수 이름으로 검색
- YouTube Data API v3의 Music 카테고리 검색 필터 사용
- 영상 상세 정보를 다시 확인해 Music 카테고리 및 외부 재생 허용 여부 확인
- 검색 결과 목록과 썸네일 표시
- YouTube 공식 내장 플레이어에서 선택한 영상 재생
- 회원가입이나 MUSIQ 계정 없음
- API 키는 현재 브라우저의 localStorage에만 저장

## 최초 설정
이 앱은 YouTube 검색을 위해 개발자 API 키가 필요합니다. 이는 사용자의 YouTube 로그인 정보가 아닙니다.

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 만듭니다.
2. [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com)를 활성화합니다.
3. API 키를 발급합니다.
4. 앱 오른쪽 위 설정 버튼에서 API 키를 입력하고 저장합니다.
5. 노래 제목이나 가수 이름을 검색합니다.

## API 키 보안
- app.js 또는 HTML에 키를 직접 넣어 GitHub에 올리지 마세요.
- Google Cloud Console에서 HTTP referrer 제한을 설정하고 API 제한은 YouTube Data API v3만 허용하도록 설정하세요.
- 브라우저에서 호출하는 API 키는 개발자 도구에서 확인될 수 있습니다. referrer 제한과 API 제한은 필수입니다.
- 공개 서비스로 운영할 때는 별도의 서버 프록시/키 관리 구조를 검토할 수 있습니다.

## 중요한 제한
- YouTube Data API 검색 할당량과 정책을 따릅니다. search.list는 호출당 할당량 비용이 크므로 반복 검색 시 일일 한도에 도달할 수 있습니다.
- 카테고리 10 필터는 YouTube가 Music으로 분류한 영상만 찾습니다. 모든 공식 음원이 이 카테고리에 포함된다고 보장할 수 없으며, 검색 결과가 적을 수 있습니다.
- YouTube 공식 플레이어, 광고, 브랜딩 및 재생 제한이 그대로 적용됩니다. 앱은 오디오 추출, 광고 제거, 플레이어 숨김을 하지 않습니다.
- 외부 재생이 허용되지 않거나 지역/연령 제한이 있는 영상은 재생되지 않을 수 있습니다.
- 백그라운드 재생은 구현하지 않았습니다.

## GitHub Pages 배포
저장소 Settings → Pages에서 main 브랜치의 /(root)를 선택하세요.
