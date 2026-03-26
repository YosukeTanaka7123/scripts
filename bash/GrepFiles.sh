#/bin/bash

############################################################
# ファイル抽出ツール
#   ファイル名に検索ワードを含むファイルを抽出する
#   指定されたディレクトリ配下のファイルが対象となる
#   .tar.gz .tgzのアーカイブ内も検索対象となる
#   また、抽出対象ファイルのディレクトリ構成を保持する
#
############################################################

# 入力チェック
if [ "${#}" -ne 2 ]; then
  echo "引数が必要（引数1：ディレクトリパス、引数2以降：検索ワード）"
  exit 255
fi

if [ ! -d "${1}" ]; then
  echo "対象のディレクトリが存在しません"
  exit 255
fi

if [ `echo "${2}" | grep "/"` ]; then
  echo "検索できない文字（/）"
  exit 255
fi

if [ "${#2}" -gt 244 ]; then
  echo "検索ワードの文字数は244byte以内にしてください"
  exit 255
fi

# 収集先ディレクトリ作成
BASEPATH=`cd $(dirname ${0}); pwd`
EXECDATE=`date "+%Y%m%d"`
n=1
extDir="${BASEPATH}/${EXECDATE}_${2}_${n}"
while [ -d "${extDir}" ]; do
  n=$((n+1))
  extDir="${BASEPATH}/${EXECDATE}_${2}_${n}"
done
mkdir "${extDir}"

# ファイル抽出
for f in `find ${1} -type f -name "*${2}*"`; do
  parentDir="${extDir}/`dirname ${1##*/}${f#$1}`"
  mkdir -p ${parentDir}
  cp ${f} ${parentDir}

  printf "."
done

# tarアーカイブファイル抽出
for targz in `find ${1} -type f -name "*.tar.gz" -or -name "*.tgz"`; do
  files=`tar -tf ${targz} | grep ${2} | tr "\n" " "`
  if [ -z "${files}" ]; then
    continue
  fi

  targz_abs="`cd ${targz%/*}; pwd`/${targz##*/}"
  parentDir="${extDir}/`dirname ${1##*/}${targz#$1}`"
  mkdir -p ${parentDir}
  cd ${parentDir}
  tar -zxvf ${targz_abs} ${files} > /dev/null

  cd ${BASEPATH}

  printf "."
done

printf "done\n"
